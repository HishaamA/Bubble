#pragma once

#include <opencv2/core.hpp>
#include <functional>
#include <stdexcept>
#include <string>
#include <vector>

namespace bubble::stitch {
struct Failure : std::runtime_error {
    std::string code;
    std::string report;
    Failure(std::string code, const std::string& message, std::string report = "")
        : std::runtime_error(message), code(std::move(code)), report(std::move(report)) {}
};

struct Callbacks {
    std::function<void(int, const std::string&)> progress;
    std::function<bool()> cancelled;
    void check() const;
    void publish(int percent, const std::string& stage) const;
};

struct View {
    std::string path;
    int originalIndex = 0, width = 0, height = 0;
    double fx = 0, fy = 0, cx = 0, cy = 0;
    cv::Matx33d rotation = cv::Matx33d::eye();
    cv::Matx33d prior = cv::Matx33d::eye();
    cv::Vec3d position{0, 0, 0};
    bool hasPose = false;
    bool hasMeasuredPosition = false;
};

struct Edge {
    int i = 0, j = 0, count = 0;
    cv::Matx33d rotation = cv::Matx33d::eye(); // j camera rays -> i camera rays
    std::vector<cv::Vec3d> rays0, rays1;
    double medianError = 0;
    bool ai = false;
};

struct Coverage {
    double sphereFraction = 0, pixelFraction = 0;
    int largestHolePixels = 0;
    double largestHoleFraction = 0;
};
// Components are connected across the longitude boundary, so a split wrap gap
// cannot evade the largest-hole gate by appearing at opposite bitmap edges.
Coverage measureCoverage(const cv::Mat& observedMask);

double percentile(std::vector<double> values, double fraction);
double angleDegrees(const cv::Vec3d& a, const cv::Vec3d& b);
cv::Matx33d expRotation(const cv::Vec3d& radians);
cv::Vec3d logRotation(const cv::Matx33d& rotation);
cv::Vec3d pixelRay(const View& view, const cv::Point2d& pixel);
cv::Matx33d fitRotation(const std::vector<cv::Vec3d>& source,
    const std::vector<cv::Vec3d>& target);
bool validatePair(const std::vector<View>& views, int i, int j,
    const std::vector<cv::Point2d>& points0, const std::vector<cv::Point2d>& points1,
    Edge& edge, const Callbacks& callbacks);
std::vector<std::vector<int>> components(int count, const std::vector<Edge>& edges);
std::vector<std::pair<int,int>> recoveryPairs(const std::vector<View>& views,
    const std::vector<Edge>& edges);
void bootstrap(std::vector<View>& views, const std::vector<Edge>& edges);
std::pair<double, double> refineRotations(std::vector<View>& views,
    const std::vector<Edge>& edges, const Callbacks& callbacks);
}
