#include "stitch_geometry.hpp"
#include "stitch_json.hpp"
#include "stitch_unicode.hpp"
#include <algorithm>
#include <cmath>
#include <iostream>
#include <random>

using namespace bubble::stitch;
namespace {
void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}
View camera() {
    View v; v.width = 1600; v.height = 1200; v.fx = 1100; v.fy = 1080; v.cx = 799.5; v.cy = 599.5;
    return v;
}
cv::Point2d pixel(const View& v, cv::Vec3d ray) {
    return {ray[0] / ray[2] * v.fx + v.cx, -ray[1] / ray[2] * v.fy + v.cy};
}
}

int main() {
    try {
        auto androidJson = parseJson(R"json({"filePath":"\/data\/data\/app\/photo.jpg","literal":"prefix\\\\/suffix","slash":"\\\/","label":"\u4f60\u597d \ud83d\ude42","optional":null,"aiUsed":true,"off":false,"n":1.25})json");
        require(text(field(androidJson,"filePath")) == "/data/data/app/photo.jpg", "Android escaped slash JSON failed");
        require(text(field(androidJson,"literal")) == R"(prefix\\/suffix)", "Literal backslashes were damaged by JSON decoding");
        require(text(field(androidJson,"slash")) == "\\/", "Escaped slash after a backslash was changed");
        require(text(field(androidJson,"label")) == u8"你好 🙂", "Unicode or surrogate pair JSON failed");
        require(standardUtf8(u"你好 🙂") == u8"你好 🙂" && javaUtf16(u8"你好 🙂") == u"你好 🙂", "Java Unicode conversion did not round-trip");
        require(text(field(parseJson(standardUtf8(u"{\"label\":\"你好 🙂\"}")),"label")) == u8"你好 🙂", "Raw Android Unicode JSON failed");
        require(field(androidJson,"optional").is_null() && field(androidJson,"missing").is_null(), "JSON null or absent fields failed");
        require(boolean(field(androidJson,"aiUsed")) && !boolean(field(androidJson,"off")), "JSON boolean handling failed");
        require(number(field(androidJson,"n")) == 1.25 && integer(Json(1e100),-1) == -1, "JSON numeric bounds failed");
        bool privateError = false;
        try { parseJson("{\"private-photo-name\":}"); }
        catch (const Failure& error) { privateError = error.code == "INVALID_JSON" && std::string(error.what()).find("private-photo-name") == std::string::npos; }
        require(privateError,"JSON parse errors exposed private input");
        const Callbacks callback{};
        View a = camera(), b = camera();
        auto rotation = expRotation(cv::Vec3d(0.015, 0.13, -0.025));
        std::vector<cv::Vec3d> source, target;
        std::vector<cv::Point2d> points0, points1;
        for (int y = 0; y < 8; ++y) for (int x = 0; x < 10; ++x) {
            cv::Point2d p(350 + x * 85, 250 + y * 90);
            auto ray = pixelRay(b, p); source.push_back(ray); target.push_back(rotation * ray);
            points0.push_back(pixel(a, rotation * ray)); points1.push_back(p);
        }
        auto fitted = fitRotation(source, target);
        require(cv::norm(logRotation(fitted * rotation.t())) < 1e-8, "Kabsch rotation uses wrong direction");
        require(angleDegrees(pixelRay(a, {a.cx,a.cy}), {0,0,1}) < 1e-8, "center ray calibration mismatch");

        std::mt19937 random(42);
        std::uniform_real_distribution<double> x(0,1599), y(0,1199);
        for (int i = 0; i < 60; ++i) {
            points0.emplace_back(x(random),y(random)); points1.emplace_back(x(random),y(random));
        }
        std::vector<View> views{a,b}; Edge edge;
        require(validatePair(views,0,1,points0,points1,edge,callback), "RANSAC rejected valid overlap with outliers");
        require(edge.count >= 75, "RANSAC lost most genuine correspondences");
        require(cv::norm(logRotation(edge.rotation * rotation.t())) < 1e-5, "RANSAC rotation is inaccurate");
        points0.clear(); points1.clear();
        for (int i = 0; i < 40; ++i) {
            cv::Point2d p(300 + i * 20, 500);
            points0.push_back(pixel(a, rotation * pixelRay(b,p))); points1.push_back(p);
        }
        Edge line;
        require(!validatePair(views,0,1,points0,points1,line,callback), "Collinear correspondence geometry was accepted");

        // A deliberately biased AR prior must be corrected by image evidence.
        views[0].hasPose = views[1].hasPose = true;
        views[0].rotation = views[0].prior = cv::Matx33d::eye();
        views[1].rotation = views[1].prior = expRotation({0.035,0.02,-0.015}) * rotation;
        auto errors = refineRotations(views, {edge}, callback);
        require(errors.first < 0.02 && errors.second < 0.03, "Global refinement did not correct biased pose");
        require(cv::norm(logRotation(views[0].rotation)) < 1e-10, "Global refinement moved gauge anchor");

        auto groups = components(3, {edge});
        require(groups.size() == 2 && groups[0].size() == 2, "Disconnected frame was not found");
        std::vector<View> weakViews{views[0],views[1],views[0]};
        auto recovery = recoveryPairs(weakViews,{edge});
        require(recovery.size() == 2, "Weak component recovery did not select its missing neighbors");
        require(std::find(recovery.begin(),recovery.end(),std::make_pair(0,1)) == recovery.end(), "Recovery duplicated existing validated edge");
        weakViews[2].prior = expRotation({0,CV_PI,0});
        require(recoveryPairs(weakViews,{edge}).empty(), "Recovery attempted nonoverlapping opposite-facing views");
        Edge e12 = edge, e20 = edge; e12.i = 1; e12.j = 2; e20.i = 2; e20.j = 0;
        weakViews[2].prior = cv::Matx33d::eye();
        require(recoveryPairs(weakViews,{edge,e12,e20}).empty(), "Recovery repeated an already strong connected graph");
        weakViews[2].hasPose = false;
        require(recoveryPairs(weakViews,{edge}).empty(), "Bounded pose-neighbor recovery guessed a missing pose");
        std::vector<View> manyViews(64,views[0]);
        auto bounded = recoveryPairs(manyViews,{});
        require(bounded.size() <= 96, "Recovery pair budget exceeded");
        std::vector<int> attempts(64,0);
        for (auto [i,j] : bounded) { ++attempts[i]; ++attempts[j]; }
        require(*std::max_element(attempts.begin(),attempts.end()) <= 4, "Recovery frame budget exceeded");
        views[0].hasPose = views[1].hasPose = false;
        bootstrap(views,{edge});
        require(cv::norm(logRotation(views[1].rotation * rotation.t())) < 1e-5, "Visual bootstrap has wrong rotation convention");
        bool cancelled = false;
        try { Callbacks{{}, []{ return true; }}.check(); }
        catch (const Failure& failure) { cancelled = failure.code == "CANCELLED"; }
        require(cancelled,"Cancellation was ignored");
        cv::Mat observed(128,256,CV_8U,cv::Scalar(255));
        auto fullCoverage = measureCoverage(observed);
        require(fullCoverage.pixelFraction == 1 && fullCoverage.largestHolePixels == 0, "Complete mask has false holes");
        observed(cv::Rect(0,40,2,5)).setTo(0);
        observed(cv::Rect(254,40,2,5)).setTo(0);
        observed.at<uchar>(90,100) = 0;
        auto gap = measureCoverage(observed);
        require(gap.largestHolePixels == 20, "Longitude-split gap was not joined periodically");
        require(std::abs(gap.pixelFraction - (1 - 21.0 / (128 * 256))) < 1e-12, "Hole coverage count is wrong");
        std::cout << "PASS: standard Android JSON escapes/Unicode/null/booleans/privacy, calibrated rays, rotation convention, robust outliers, degenerate rejection, global refinement, graph connectivity, bounded recovery, bootstrap, cancellation, periodic hole components\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << '\n'; return 1;
    }
}
