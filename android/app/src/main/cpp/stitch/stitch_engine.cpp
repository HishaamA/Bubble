#include "stitch_engine.hpp"
#include "stitch_json.hpp"
#include <opencv2/calib3d.hpp>
#include <opencv2/features2d.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/stitching/detail/blenders.hpp>
#include <opencv2/stitching/detail/seam_finders.hpp>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <numeric>
#include <set>
#include <sstream>

namespace bubble::stitch {
namespace {
constexpr int MAX_FRAMES = 64;
constexpr int SEAM_WIDTH = 1024;
constexpr int SOURCE_LONG_EDGE = 3072;

std::string quote(const std::string& value) {
    std::ostringstream out; out << '"';
    for (unsigned char ch : value) {
        switch (ch) {
            case '"': out << "\\\""; break;
            case '\\': out << "\\\\"; break;
            case '\n': out << "\\n"; break;
            case '\r': out << "\\r"; break;
            case '\t': out << "\\t"; break;
            default:
                if (ch < 32) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << int(ch) << std::dec;
                else out << ch;
        }
    }
    out << '"'; return out.str();
}
std::string stringsJson(const std::vector<std::string>& values) {
    std::string json = "[";
    for (size_t i = 0; i < values.size(); ++i) json += (i ? "," : "") + quote(values[i]);
    return json + "]";
}
std::string indicesJson(const std::vector<int>& values) {
    std::ostringstream out; out << '[';
    for (size_t i = 0; i < values.size(); ++i) { if (i) out << ','; out << values[i]; }
    out << ']'; return out.str();
}
// Check the JPEG header before allocating a decoded image. Never trust declared dimensions
// to bound allocations, and never let automatic EXIF rotation silently change calibration.
cv::Size jpegDimensions(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file || file.get() != 0xff || file.get() != 0xd8)
        throw Failure("INVALID_SOURCE", "A source is not an accessible upright JPEG.");
    for (int segment = 0; segment < 4096 && file; ++segment) {
        int prefix = file.get();
        if (prefix != 0xff) throw Failure("INVALID_SOURCE", "A JPEG header is damaged.");
        int marker; do { marker = file.get(); } while (marker == 0xff);
        if (marker == 0xd9 || marker == 0xda || marker < 0) break;
        if (marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        int high = file.get(), low = file.get();
        if (high < 0 || low < 0) break;
        int length = (high << 8) + low;
        if (length < 2) break;
        bool sof = marker >= 0xc0 && marker <= 0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc;
        if (sof && length >= 8) {
            file.get();
            int h0 = file.get(), h1 = file.get(), w0 = file.get(), w1 = file.get();
            if (std::min({h0, h1, w0, w1}) < 0) break;
            int width = (w0 << 8) + w1, height = (h0 << 8) + h1;
            if (std::min(width, height) < 128 || static_cast<int64_t>(width) * height > 40000000)
                throw Failure("INVALID_SOURCE_SIZE", "Use source photos between 128 pixels and 40 megapixels.");
            return {width, height};
        }
        file.seekg(length - 2, std::ios::cur);
    }
    throw Failure("INVALID_SOURCE", "A JPEG image header is incomplete.");
}

std::vector<View> readViews(const Json& frames, std::vector<std::string>& warnings) {
    if (!frames.is_array() || frames.size() < 8 || frames.size() > MAX_FRAMES)
        throw Failure("INVALID_FRAME_COUNT", "Use 8–64 overlapping photos covering the complete sphere.");
    std::vector<View> views;
    bool estimatedCalibration = false;
    for (const auto& frame : frames) {
        View v; v.originalIndex = static_cast<int>(views.size());
        v.path = text(field(frame,"filePath"), text(field(frame,"path")));
        if (v.path.empty()) throw Failure("INVALID_SOURCE", "A source photo path is missing.");
        cv::Size size = jpegDimensions(v.path);
        v.width = integer(field(frame,"width"), size.width);
        v.height = integer(field(frame,"height"), size.height);
        if (v.width != size.width || v.height != size.height)
            throw Failure("CALIBRATION_SIZE_MISMATCH", "A photo's dimensions disagree with its camera calibration.");
        const auto& intrinsic = field(frame,"intrinsics");
        if (intrinsic.is_array() && intrinsic.size() >= 6) {
            v.fx = number(intrinsic[0]); v.fy = number(intrinsic[4]);
            v.cx = number(intrinsic[2], NAN); v.cy = number(intrinsic[5], NAN);
        } else {
            double fov = std::clamp(number(field(frame,"horizontalFovDegrees"), 68), 35.0, 110.0);
            v.fx = v.fy = v.width / (2 * std::tan(fov * CV_PI / 360));
            v.cx = (v.width - 1) / 2.0; v.cy = (v.height - 1) / 2.0;
            estimatedCalibration = true;
        }
        if (v.fx <= 0 || v.fy <= 0 || !std::isfinite(v.cx) || !std::isfinite(v.cy) ||
            v.cx < 0 || v.cx >= v.width || v.cy < 0 || v.cy >= v.height)
            throw Failure("INVALID_CALIBRATION", "A camera calibration is invalid. Retake or re-import the photos.");
        const auto& transform = field(frame,"transform");
        if (transform.is_array() && transform.size() == 16) {
            double t[16]; for (int k = 0; k < 16; ++k) {
                t[k] = number(transform[k], NAN);
                if (!std::isfinite(t[k])) throw Failure("INVALID_POSE", "A camera transform is invalid.");
            }
            v.rotation = cv::Matx33d(t[0], t[4], -t[8], t[1], t[5], -t[9], -t[2], -t[6], t[10]);
            if (cv::norm(cv::Mat(v.rotation.t() * v.rotation - cv::Matx33d::eye())) > 0.15 ||
                cv::determinant(cv::Mat(v.rotation)) < 0.8)
                throw Failure("INVALID_POSE", "A camera transform is not a valid rotation.");
            cv::Mat w, u, vt; cv::SVD::compute(cv::Mat(v.rotation), w, u, vt);
            v.rotation = cv::Matx33d(cv::Mat(u * vt)); v.prior = v.rotation;
            v.position = {t[12], t[13], t[14]}; v.hasPose = true;
            v.hasMeasuredPosition = frame.value("translationAvailable", true);
        } else if (!transform.is_null()) {
            throw Failure("INVALID_POSE", "A camera transform is incomplete.");
        }
        views.push_back(v);
    }
    bool anyPose = std::any_of(views.begin(), views.end(), [](const View& v) { return v.hasPose; });
    bool allPose = std::all_of(views.begin(), views.end(), [](const View& v) { return v.hasPose; });
    if (anyPose && !allPose) throw Failure("MIXED_POSES", "Use one complete capture; these photos mix pose conventions.");
    if (estimatedCalibration)
        warnings.push_back("Some photos use estimated focal lengths. Reprojection quality is checked, but calibrated captures are more reliable.");
    if (!allPose) warnings.push_back("Camera rotations are estimated from visual overlap; inspect the horizon after assembly.");
    return views;
}

cv::Mat decode(const View& v, int longEdge) {
    int divisor = 1;
    while (divisor < 8 && std::max(v.width, v.height) / (divisor * 2) >= longEdge) divisor *= 2;
    int flag = divisor == 8 ? cv::IMREAD_REDUCED_COLOR_8 : divisor == 4 ? cv::IMREAD_REDUCED_COLOR_4 :
        divisor == 2 ? cv::IMREAD_REDUCED_COLOR_2 : cv::IMREAD_COLOR;
    cv::Mat image = cv::imread(v.path, flag | cv::IMREAD_IGNORE_ORIENTATION);
    if (image.empty()) throw Failure("DECODE_FAILED", "A source photo could not be decoded.");
    double scale = std::min(1.0, longEdge / static_cast<double>(std::max(image.cols, image.rows)));
    if (scale < 1) cv::resize(image, image, {}, scale, scale, cv::INTER_AREA);
    return image;
}

std::vector<cv::Point2d> points(const Json& node) {
    std::vector<cv::Point2d> result;
    if (!node.is_array() || node.size() > 10000) return result;
    for (const auto& pair : node) {
        if (!pair.is_array() || pair.size() != 2) return {};
        result.emplace_back(number(pair[0], NAN), number(pair[1], NAN));
    }
    return result;
}

std::vector<Edge> classicalMatches(const std::vector<View>& views, const Callbacks& callbacks,
    const std::vector<std::pair<int,int>>* recovery = nullptr) {
    struct Features { std::vector<cv::KeyPoint> keys; cv::Mat descriptors; double sx, sy; };
    std::vector<Features> features(views.size());
    std::set<int> needed;
    if (recovery) for (auto [i,j] : *recovery) { needed.insert(i); needed.insert(j); }
    auto sift = cv::SIFT::create(3000, 3, 0.025, 10, 1.6);
    for (size_t i = 0; i < views.size(); ++i) {
        if (recovery && !needed.count(static_cast<int>(i))) continue;
        callbacks.publish(recovery ? 24 : 2 + static_cast<int>(i * 7 / views.size()), "extracting local SIFT features");
        cv::Mat image = decode(views[i], 1024), gray;
        cv::cvtColor(image, gray, cv::COLOR_BGR2GRAY);
        auto& f = features[i]; f.sx = static_cast<double>(views[i].width) / image.cols;
        f.sy = static_cast<double>(views[i].height) / image.rows;
        sift->detectAndCompute(gray, cv::noArray(), f.keys, f.descriptors);
    }
    std::vector<std::pair<int, int>> candidates;
    if (recovery) candidates = *recovery;
    else {
        for (size_t i = 0; i < views.size(); ++i) for (size_t j = i + 1; j < views.size(); ++j) {
            if (views[i].hasPose && angleDegrees(views[i].prior * cv::Vec3d(0,0,1), views[j].prior * cv::Vec3d(0,0,1)) >= 85) continue;
            candidates.emplace_back(static_cast<int>(i), static_cast<int>(j));
        }
    }
    std::vector<Edge> edges;
    cv::BFMatcher matcher(cv::NORM_L2);
    for (size_t pair = 0; pair < candidates.size(); ++pair) {
        callbacks.publish(recovery ? 24 : 10 + static_cast<int>(pair * 14 / std::max<size_t>(1, candidates.size())), "validating visual overlap");
        auto [i, j] = candidates[pair]; const auto &a = features[i], &b = features[j];
        if (a.descriptors.rows < 12 || b.descriptors.rows < 12) continue;
        std::vector<std::vector<cv::DMatch>> forward, reverse;
        matcher.knnMatch(a.descriptors, b.descriptors, forward, 2);
        matcher.knnMatch(b.descriptors, a.descriptors, reverse, 2);
        std::vector<cv::Point2d> p0, p1;
        for (const auto& match : forward) {
            if (match.size() < 2 || match[0].distance >= 0.75f * match[1].distance) continue;
            const auto& m = match[0]; const auto& back = reverse[m.trainIdx];
            if (back.size() < 2 || back[0].distance >= 0.75f * back[1].distance || back[0].trainIdx != m.queryIdx) continue;
            auto x = a.keys[m.queryIdx].pt, y = b.keys[m.trainIdx].pt;
            p0.emplace_back(x.x * a.sx, x.y * a.sy); p1.emplace_back(y.x * b.sx, y.y * b.sy);
        }
        Edge edge;
        if (validatePair(views, i, j, p0, p1, edge, callbacks)) edges.push_back(std::move(edge));
    }
    return edges;
}

std::vector<Edge> readMatches(const std::vector<View>& views, const std::string& json,
    std::string& model, std::vector<std::string>& warnings, const Callbacks& callbacks) {
    if (json.empty()) {
        warnings.push_back("Learned matching was unavailable; calibrated native SIFT matching was used.");
        model = "OpenCV SIFT"; return classicalMatches(views, callbacks);
    }
    auto storage = parseJson(json); const auto& pairs = field(storage,"pairs");
    if (!pairs.is_array() || pairs.empty()) {
        warnings.push_back("Learned matching supplied no pairs; calibrated native SIFT matching was used.");
        model = "OpenCV SIFT"; return classicalMatches(views, callbacks);
    }
    if (pairs.size() > MAX_FRAMES * (MAX_FRAMES - 1) / 2)
        throw Failure("INVALID_MATCHES", "The correspondence set is too large.");
    model = text(field(storage,"model"), "learned feature matcher");
    bool ai = boolean(field(storage,"aiUsed"));
    std::set<std::pair<int, int>> seen;
    std::vector<Edge> edges;
    int index = 0;
    for (const auto& pair : pairs) {
        callbacks.publish(3 + index++ * 21 / static_cast<int>(pairs.size()), "validating calibrated correspondences");
        int i = integer(field(pair,"i"), -1), j = integer(field(pair,"j"), -1);
        if (i < 0 || j < 0 || i >= static_cast<int>(views.size()) || j >= static_cast<int>(views.size()) || i == j) continue;
        if (!seen.emplace(std::min(i, j), std::max(i, j)).second) continue;
        Edge edge;
        if (validatePair(views, i, j, points(field(pair,"points0")), points(field(pair,"points1")), edge, callbacks)) {
            edge.ai = boolean(field(pair,"aiUsed"), ai);
            edges.push_back(std::move(edge));
        }
    }
    return edges;
}

struct Projection { cv::Mat image, valid, score; };
Projection project(const cv::Mat& source, const View& view, int width, int pad,
    int rowStart, int rowEnd, bool scores, const Callbacks& callbacks) {
    const int height = width / 2, fullWidth = width + pad * 2;
    Projection p;
    p.image.create(rowEnd - rowStart, fullWidth, CV_8UC3);
    p.valid.create(rowEnd - rowStart, fullWidth, CV_8U);
    if (scores) p.score.create(rowEnd - rowStart, fullWidth, CV_32F);
    double fx = view.fx * source.cols / view.width, fy = view.fy * source.rows / view.height;
    double cx = view.cx * source.cols / view.width, cy = view.cy * source.rows / view.height;
    cv::Matx33d inverse = view.rotation.t();
    std::vector<double> sine(fullWidth), cosine(fullWidth);
    for (int x = 0; x < fullWidth; ++x) {
        double yaw = ((x - pad + 0.5) / width - 0.5) * 2 * CV_PI;
        sine[x] = std::sin(yaw); cosine[x] = std::cos(yaw);
    }
    for (int start = rowStart; start < rowEnd; start += 64) {
        callbacks.check();
        int end = std::min(rowEnd, start + 64);
        cv::Mat mx(end - start, fullWidth, CV_32F), my(end - start, fullWidth, CV_32F);
        for (int y = start; y < end; ++y) {
            double pitch = (0.5 - (y + 0.5) / height) * CV_PI;
            double sp = std::sin(pitch), cp = std::cos(pitch);
            float *px = mx.ptr<float>(y - start), *py = my.ptr<float>(y - start);
            uchar* valid = p.valid.ptr<uchar>(y - rowStart);
            float* confidence = scores ? p.score.ptr<float>(y - rowStart) : nullptr;
            for (int x = 0; x < fullWidth; ++x) {
                cv::Vec3d ray = inverse * cv::Vec3d(cp * sine[x], sp, cp * cosine[x]);
                double depth = std::max(ray[2], 1e-6);
                double sx = ray[0] / depth * fx + cx, sy = -ray[1] / depth * fy + cy;
                // Limiting invalid coordinates also avoids overflow inside fixed-point remap.
                px[x] = static_cast<float>(std::clamp(sx, -32760.0, 32760.0));
                py[x] = static_cast<float>(std::clamp(sy, -32760.0, 32760.0));
                bool inside = ray[2] > 0 && sx >= 1 && sy >= 1 && sx < source.cols - 2 && sy < source.rows - 2;
                valid[x] = inside ? 255 : 0;
                if (confidence) {
                    double nx = std::abs((sx - cx) / std::max(cx, source.cols - 1 - cx));
                    double ny = std::abs((sy - cy) / std::max(cy, source.rows - 1 - cy));
                    confidence[x] = inside ? static_cast<float>(std::max(0.01, 1 - std::max(nx, ny))) : 0;
                }
            }
        }
        cv::Mat destination = p.image.rowRange(start - rowStart, end - rowStart);
        cv::remap(source, destination, mx, my, cv::INTER_LINEAR, cv::BORDER_REPLICATE);
    }
    return p;
}

void requireCoverage(const Coverage& amount, int pixelCount) {
    const int maximumHole = std::max(12, static_cast<int>(pixelCount * 0.000025));
    if (amount.sphereFraction < 0.9998 || amount.pixelFraction < 0.9998 || amount.largestHolePixels > maximumHole) {
        std::ostringstream message;
        message << "The photos leave " << std::fixed << std::setprecision(3) << (1 - amount.sphereFraction) * 100
            << "% of the sphere and " << (1 - amount.pixelFraction) * 100
            << "% of the panorama pixels uncovered (largest connected gap " << amount.largestHolePixels
            << " pixels). Add overlapping ceiling, floor, or missing views; missing content will not be invented.";
        std::ostringstream report;
        report << "{\"coverage\":" << std::setprecision(8) << amount.sphereFraction
            << ",\"pixelCoverage\":" << amount.pixelFraction << ",\"largestHolePixels\":" << amount.largestHolePixels
            << ",\"largestHoleFraction\":" << amount.largestHoleFraction << ",\"generativeFill\":false}";
        throw Failure("INSUFFICIENT_COVERAGE", message.str(), report.str());
    }
}

struct LowView { cv::Mat image, valid, seam; cv::Rect box; };
std::vector<double> exposureGains(const std::vector<LowView>& low, const Callbacks& callbacks) {
    int count = static_cast<int>(low.size());
    std::vector<cv::Mat> gray(count);
    for (int i = 0; i < count; ++i) cv::cvtColor(low[i].image, gray[i], cv::COLOR_BGR2GRAY);
    cv::Mat normal = cv::Mat::eye(count, count, CV_64F) * 0.0025, rhs = cv::Mat::zeros(count, 1, CV_64F);
    for (int i = 0; i < count; ++i) for (int j = i + 1; j < count; ++j) {
        callbacks.check(); std::vector<double> ratios;
        for (int y = 0; y < gray[i].rows; y += 3) {
            const uchar *a = gray[i].ptr<uchar>(y), *b = gray[j].ptr<uchar>(y);
            const uchar *ma = low[i].valid.ptr<uchar>(y), *mb = low[j].valid.ptr<uchar>(y);
            for (int x = 0; x < gray[i].cols; x += 3)
                if (ma[x] && mb[x] && a[x] > 15 && b[x] > 15 && a[x] < 238 && b[x] < 238)
                    ratios.push_back(std::log(static_cast<double>(b[x]) / a[x]));
        }
        if (ratios.size() < 64) continue;
        double median = percentile(ratios, 0.5);
        for (double& ratio : ratios) ratio = std::abs(ratio - median);
        if (percentile(ratios, 0.5) > 0.3) continue;
        normal.at<double>(i,i) += 1; normal.at<double>(j,j) += 1;
        normal.at<double>(i,j) -= 1; normal.at<double>(j,i) -= 1;
        rhs.at<double>(i) += median; rhs.at<double>(j) -= median;
    }
    cv::Mat solved; cv::solve(normal, rhs, solved, cv::DECOMP_CHOLESKY);
    std::vector<double> logs(count), gains(count);
    for (int i = 0; i < count; ++i) logs[i] = solved.at<double>(i);
    double center = percentile(logs, 0.5);
    for (int i = 0; i < count; ++i) gains[i] = std::exp(std::clamp(logs[i] - center, -0.35, 0.35));
    return gains;
}

void lockCollar(cv::Mat& mask, int index, const std::vector<int>& owners) {
    constexpr int collar = 4;
    for (int y = 0; y < mask.rows; ++y) if (owners[y] >= 0) {
        uchar* row = mask.ptr<uchar>(y);
        // An owner exists only when its real source covers every collar pixel.
        const uchar selected = owners[y] == index ? 255 : 0;
        for (int x = 0; x < collar; ++x) row[x] = row[mask.cols - 1 - x] = selected;
    }
}

std::vector<cv::Mat> findSeams(std::vector<LowView>& low, const std::vector<double>& gains,
    const cv::Mat& bestOwner, const std::vector<int>& collarOwners, const Callbacks& callbacks) {
    constexpr int pad = 48;
    int width = low[0].valid.cols, height = low[0].valid.rows;
    for (size_t i = 0; i < low.size(); ++i) {
        cv::Mat mask = low[i].valid.clone(); lockCollar(mask, static_cast<int>(i), collarOwners);
        cv::copyMakeBorder(mask, mask, 0, 0, pad, pad, cv::BORDER_WRAP);
        low[i].box = cv::boundingRect(mask);
        if (low[i].box.empty()) throw Failure("EMPTY_PROJECTION", "A matched photo has no usable spherical coverage.");
        low[i].seam = mask(low[i].box).clone();
    }
    // OpenCV's graph-cut stitcher itself solves overlapping pairs. Doing each pair
    // explicitly bounds float-image memory and gives cancellation a boundary per overlap.
    cv::detail::GraphCutSeamFinder finder(cv::detail::GraphCutSeamFinderBase::COST_COLOR_GRAD);
    for (size_t i = 0; i < low.size(); ++i) for (size_t j = i + 1; j < low.size(); ++j) {
        callbacks.publish(49 + static_cast<int>(i * 8 / low.size()), "choosing parallax-aware seams");
        auto overlap = low[i].box & low[j].box;
        if (overlap.empty()) continue;
        cv::Mat joint;
        cv::bitwise_and(low[i].seam(overlap - low[i].box.tl()), low[j].seam(overlap - low[j].box.tl()), joint);
        if (cv::countNonZero(joint) < 16) continue;
        std::vector<cv::UMat> images(2), masks(2);
        std::vector<cv::Point> corners{low[i].box.tl(), low[j].box.tl()};
        size_t ids[] = {i, j};
        for (int side = 0; side < 2; ++side) {
            size_t index = ids[side]; cv::Mat extended, corrected;
            cv::copyMakeBorder(low[index].image, extended, 0, 0, pad, pad, cv::BORDER_WRAP);
            extended(low[index].box).convertTo(corrected, CV_32FC3, gains[index]);
            corrected.copyTo(images[side]); low[index].seam.copyTo(masks[side]);
        }
        finder.find(images, corners, masks);
        masks[0].copyTo(low[i].seam); masks[1].copyTo(low[j].seam);
    }
    std::vector<cv::Mat> seams;
    cv::Mat unionMask = cv::Mat::zeros(height, width, CV_8U);
    for (auto& view : low) {
        cv::Mat extended = cv::Mat::zeros(height, width + pad * 2, CV_8U);
        view.seam.copyTo(extended(view.box));
        cv::Mat selected;
        cv::bitwise_and(extended(cv::Rect(pad, 0, width, height)), view.valid, selected);
        cv::bitwise_or(unionMask, selected, unionMask); seams.push_back(selected);
    }
    // Repair only graph-cut ownership holes at already observed pixels, never scene holes.
    for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
        int owner = bestOwner.at<short>(y, x);
        if (!unionMask.at<uchar>(y, x) && owner >= 0) seams[owner].at<uchar>(y, x) = 255;
    }
    for (size_t i = 0; i < seams.size(); ++i) lockCollar(seams[i], static_cast<int>(i), collarOwners);
    return seams;
}

struct Blended { cv::Mat image, observed; };
Blended blend(const std::vector<View>& views, std::vector<cv::Mat>& seams,
    const std::vector<double>& gains, int width, const Callbacks& callbacks) {
    const int height = width / 2;
    const int bands = std::clamp(static_cast<int>(std::lround(std::log2(width))) - 6, 4, 6);
    const int pad = 1 << (bands + 1), coreRows = 512, fullWidth = width + pad * 2;
    Blended result{cv::Mat::zeros(height, width, CV_8UC3), cv::Mat::zeros(height, width, CV_8U)};
    for (auto& seam : seams) {
        cv::Mat extended; cv::copyMakeBorder(seam, extended, 0, 0, 2, 2, cv::BORDER_WRAP);
        cv::dilate(extended, extended, cv::Mat::ones(3, 3, CV_8U));
        seam = extended(cv::Rect(2, 0, seam.cols, seam.rows)).clone();
    }
    const int strips = (height + coreRows - 1) / coreRows;
    for (int strip = 0; strip < strips; ++strip) {
        const int first = strip * coreRows, last = std::min(height, first + coreRows);
        const int start = std::max(0, first - pad), end = std::min(height, last + pad);
        cv::detail::MultiBandBlender blender(false, bands, CV_32F);
        blender.prepare(cv::Rect(0, start, fullWidth, end - start));
        cv::Mat observed = cv::Mat::zeros(end - start, fullWidth, CV_8U);
        for (size_t i = 0; i < views.size(); ++i) {
            callbacks.publish(58 + static_cast<int>((strip * views.size() + i) * 36 / (strips * views.size())), "blending original photos");
            cv::Mat resized, padded, selected, corrected;
            cv::resize(seams[i], resized, {width, height}, 0, 0, cv::INTER_NEAREST);
            cv::copyMakeBorder(resized.rowRange(start, end), padded, 0, 0, pad, pad, cv::BORDER_WRAP);
            resized.release();
            if (!cv::countNonZero(padded)) continue;
            cv::Mat source = decode(views[i], SOURCE_LONG_EDGE);
            auto warped = project(source, views[i], width, pad, start, end, false, callbacks);
            source.release();
            cv::bitwise_or(observed, warped.valid, observed);
            cv::bitwise_and(padded, warped.valid, selected);
            if (!cv::countNonZero(selected)) continue;
            warped.image.convertTo(corrected, CV_16SC3, gains[i]);
            warped.image.release(); warped.valid.release(); padded.release();
            blender.feed(corrected, selected, {0, start});
        }
        callbacks.check(); cv::Mat output, mask; blender.blend(output, mask);
        cv::bitwise_and(observed, mask, observed);
        cv::Rect crop(pad, first - start, width, last - first);
        output(crop).convertTo(result.image.rowRange(first, last), CV_8UC3);
        observed(crop).copyTo(result.observed.rowRange(first, last));
    }
    result.image.setTo(cv::Scalar(), result.observed == 0);
    return result;
}
}

std::string errorJson(const std::string& code, const std::string& message, const std::string& report) {
    bool cancelled = code == "CANCELLED";
    bool quality = code == "INSUFFICIENT_COVERAGE" || code == "INSUFFICIENT_GEOMETRY" ||
        code == "DISCONNECTED_GEOMETRY" || code == "EXCESSIVE_PARALLAX" || code == "EMPTY_PROJECTION";
    return "{\"ok\":false,\"state\":" + quote(cancelled ? "cancelled" : "failed") +
        ",\"code\":" + quote(cancelled ? "cancelled" : code == "MEMORY_LIMIT" ? "out_of_memory" : quality ? "quality_rejected" : "stitch_failed") +
        ",\"reasonCode\":" + quote(code) + ",\"error\":" + quote(message) +
        (report.empty() ? "" : ",\"report\":" + report) + "}";
}

std::string runStitch(const std::string& manifestJson, const std::string& outputDirectory,
    const std::string& matchesJson, int outputWidth, const Callbacks& callbacks) {
    if (outputWidth < 1024 || outputWidth > 6144 || outputWidth % 2)
        throw Failure("INVALID_OUTPUT_SIZE", "Use an even panorama width between 1024 and 6144 pixels.");
    callbacks.publish(0, "checking original photos");
    auto manifest = parseJson(manifestJson);
    std::vector<std::string> warnings;
    auto views = readViews(field(manifest,"frames"), warnings);
    const int inputCount = static_cast<int>(views.size());
    std::string model;
    auto edges = readMatches(views, matchesJson, model, warnings, callbacks);
    int recoveredPairs = 0;
    if (model != "OpenCV SIFT") {
        auto candidates = recoveryPairs(views,edges);
        if (!candidates.empty()) {
            auto recovered = classicalMatches(views,callbacks,&candidates);
            recoveredPairs = static_cast<int>(recovered.size());
            edges.insert(edges.end(),recovered.begin(),recovered.end());
            if (recoveredPairs) {
                bool retainedLearned = std::any_of(edges.begin(),edges.end(),[](const Edge& edge){return edge.ai;});
                model = retainedLearned ? model + " + validated SIFT recovery" : "OpenCV SIFT recovery";
                warnings.push_back(std::to_string(recoveredPairs) + " weak visual overlap(s) were recovered with calibrated native SIFT matching.");
            }
        }
    }
    auto groups = components(inputCount, edges);
    if (edges.size() < static_cast<size_t>(std::max(4, inputCount / 3)) ||
        groups[0].size() < static_cast<size_t>(std::max(8, static_cast<int>(std::ceil(inputCount * 0.6)))))
        throw Failure("INSUFFICIENT_GEOMETRY", "Too few photos align reliably. Retake with more overlap, sharper detail, and a stationary lens position.",
            "{\"inputFrames\":" + std::to_string(inputCount) + ",\"matchedPairs\":" + std::to_string(edges.size()) +
            ",\"alignedFrames\":" + std::to_string(groups[0].size()) +
            ",\"method\":" + quote(model) + ",\"aiUsed\":" +
            (std::any_of(edges.begin(),edges.end(),[](const Edge& edge){return edge.ai;}) ? "true" : "false") +
            ",\"classicalRecoveryPairs\":" + std::to_string(recoveredPairs) +
            ",\"warnings\":" + stringsJson(warnings) + "}");
    std::vector<int> excluded;
    if (groups.size() > 1) {
        std::set<int> included(groups[0].begin(), groups[0].end());
        std::vector<int> remap(inputCount, -1); std::vector<View> selected;
        for (int i = 0; i < inputCount; ++i) {
            if (included.count(i)) { remap[i] = static_cast<int>(selected.size()); selected.push_back(views[i]); }
            else excluded.push_back(views[i].originalIndex);
        }
        std::vector<Edge> selectedEdges;
        for (auto edge : edges) if (remap[edge.i] >= 0 && remap[edge.j] >= 0) {
            edge.i = remap[edge.i]; edge.j = remap[edge.j]; selectedEdges.push_back(std::move(edge));
        }
        views.swap(selected); edges.swap(selectedEdges);
        warnings.push_back(std::to_string(excluded.size()) + " photo(s) outside the connected visual group were excluded. Remaining photos must independently pass full-sphere coverage.");
    }
    if (!views[0].hasPose) bootstrap(views, edges);
    auto residuals = refineRotations(views, edges, callbacks);
    const double medianLimit = std::min(0.2, 2.0 * 360 / outputWidth);
    const double p95Limit = std::min(0.6, 6.0 * 360 / outputWidth);
    if (residuals.first > medianLimit || residuals.second > p95Limit) {
        std::ostringstream report;
        report << "{\"inputFrames\":" << inputCount << ",\"alignedFrames\":" << views.size()
            << ",\"matchedPairs\":" << edges.size() << ",\"alignmentErrorDegrees\":" << residuals.first
            << ",\"alignmentP95Degrees\":" << residuals.second << ",\"alignmentMedianPixels\":" << residuals.first * outputWidth / 360
            << ",\"alignmentP95Pixels\":" << residuals.second * outputWidth / 360 << "}";
        throw Failure("EXCESSIVE_PARALLAX", "Photos disagree too much for a clean sphere. Keep the lens in one position and avoid moving people between shots.", report.str());
    }
    if (residuals.first > 0.1 || residuals.second > 0.3)
        warnings.push_back("Some overlaps contain parallax or movement. Inspect nearby objects and people for seam artifacts.");
    if (views[0].hasPose) {
        cv::Vec3d minimum, maximum;
        int measuredPositions = 0;
        for (const auto& view : views) {
            if (!view.hasMeasuredPosition) continue;
            if (measuredPositions++ == 0) minimum = maximum = view.position;
            for (int c = 0; c < 3; ++c) {
                minimum[c] = std::min(minimum[c], view.position[c]); maximum[c] = std::max(maximum[c], view.position[c]);
            }
        }
        if (measuredPositions < static_cast<int>(views.size()))
            warnings.push_back("Some blank surfaces used gyro-assisted orientation; lens movement was not measured for those photos.");
        if (measuredPositions > 1 && cv::norm(maximum - minimum) > 0.2)
            warnings.push_back("The lens moved during capture. Seam selection can reduce, but cannot undo, parallax around nearby surfaces.");
    } else {
        cv::Vec3d up(0,0,0);
        for (const auto& view : views) up += view.rotation * cv::Vec3d(0,1,0);
        if (cv::norm(up) / views.size() > 0.25) {
            up /= cv::norm(up); auto axis = up.cross(cv::Vec3d(0,1,0)); double sine = cv::norm(axis);
            cv::Matx33d level = cv::Matx33d::eye();
            if (sine > 1e-7) level = expRotation(axis * (std::atan2(sine, up[1]) / sine));
            else if (up[1] < 0) level = expRotation(cv::Vec3d(CV_PI,0,0));
            for (auto& view : views) view.rotation = level * view.rotation;
        }
    }
    const int seamWidth = std::min(SEAM_WIDTH, outputWidth), seamHeight = seamWidth / 2;
    std::vector<LowView> low;
    cv::Mat coverageMask = cv::Mat::zeros(seamHeight, seamWidth, CV_8U);
    cv::Mat bestScore = cv::Mat::zeros(seamHeight, seamWidth, CV_32F);
    cv::Mat bestOwner(seamHeight, seamWidth, CV_16S, cv::Scalar(-1));
    std::vector<float> collarScores(seamHeight, 0); std::vector<int> collarOwners(seamHeight, -1);
    int blurry = 0;
    for (size_t i = 0; i < views.size(); ++i) {
        callbacks.publish(36 + static_cast<int>(i * 10 / views.size()), "measuring spherical coverage");
        cv::Mat source = decode(views[i], 1536), gray, lap;
        cv::cvtColor(source, gray, cv::COLOR_BGR2GRAY); cv::Laplacian(gray, lap, CV_32F);
        cv::Scalar mean, sd; cv::meanStdDev(lap, mean, sd); if (sd[0] * sd[0] < 25) ++blurry;
        auto warped = project(source, views[i], seamWidth, 0, 0, seamHeight, true, callbacks);
        cv::bitwise_or(coverageMask, warped.valid, coverageMask);
        for (int y = 0; y < seamHeight; ++y) {
            float *best = bestScore.ptr<float>(y), *score = warped.score.ptr<float>(y);
            short* owner = bestOwner.ptr<short>(y);
            for (int x = 0; x < seamWidth; ++x) if (score[x] > best[x]) { best[x] = score[x]; owner[x] = static_cast<short>(i); }
            float scoreAtWrap = 1;
            for (int x = 0; x < 4; ++x) scoreAtWrap = std::min({scoreAtWrap, score[x], score[seamWidth - 1 - x]});
            if (scoreAtWrap > collarScores[y]) { collarScores[y] = scoreAtWrap; collarOwners[y] = static_cast<int>(i); }
        }
        low.push_back({warped.image, warped.valid, {}, {}});
    }
    requireCoverage(measureCoverage(coverageMask), static_cast<int>(coverageMask.total()));
    if (blurry) warnings.push_back(std::to_string(blurry) + " photo(s) have little sharp detail; existing blur cannot be reconstructed reliably.");
    callbacks.publish(47, "balancing exposure");
    auto gains = exposureGains(low, callbacks);
    auto seams = findSeams(low, gains, bestOwner, collarOwners, callbacks);
    low.clear(); low.shrink_to_fit(); bestScore.release(); bestOwner.release(); coverageMask.release();
    auto blended = blend(views, seams, gains, outputWidth, callbacks);
    auto finalCoverage = measureCoverage(blended.observed);
    requireCoverage(finalCoverage, static_cast<int>(blended.observed.total()));
    if (finalCoverage.pixelFraction < 1)
        warnings.push_back("Tiny uncaptured areas remain dark. No missing scene content was generated.");
    std::vector<double> wrapDifferences;
    for (int y = 0; y < blended.image.rows; ++y) if (blended.observed.at<uchar>(y, 0) && blended.observed.at<uchar>(y, outputWidth - 1)) {
        auto a = blended.image.at<cv::Vec3b>(y, 0), b = blended.image.at<cv::Vec3b>(y, outputWidth - 1);
        wrapDifferences.push_back((std::abs(a[0]-b[0]) + std::abs(a[1]-b[1]) + std::abs(a[2]-b[2])) / 3.0);
    }
    double wrapMedian = percentile(wrapDifferences, 0.5);
    if (wrapMedian > 18) warnings.push_back("The longitude boundary has a visible color difference; inspect the wrap seam.");
    callbacks.publish(95, "saving the measured panorama");
    std::filesystem::path directory(outputDirectory);
    if (directory.empty()) throw Failure("INVALID_OUTPUT_PATH", "The panorama output directory is missing.");
    std::filesystem::create_directories(directory);
    // Unique names preserve previous successful outputs if the caller reuses a job folder.
    auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
    std::string suffix = std::to_string(stamp);
    auto panorama = directory / ("panorama-" + suffix + ".jpg");
    auto thumbnail = directory / ("thumbnail-" + suffix + ".jpg");
    if (std::filesystem::exists(panorama) || std::filesystem::exists(thumbnail))
        throw Failure("OUTPUT_EXISTS", "This output filename already exists; retry in a new job folder.");
    if (!cv::imwrite(panorama.string(), blended.image, {cv::IMWRITE_JPEG_QUALITY, 95}))
        throw Failure("ENCODE_FAILED", "The panorama could not be saved.");
    callbacks.check(); cv::Mat preview;
    cv::resize(blended.image, preview, {640,320}, 0, 0, cv::INTER_AREA);
    if (!cv::imwrite(thumbnail.string(), preview, {cv::IMWRITE_JPEG_QUALITY, 88}))
        throw Failure("ENCODE_FAILED", "The panorama preview could not be saved.");
    bool ai = std::any_of(edges.begin(), edges.end(), [](const Edge& e) { return e.ai; });
    std::ostringstream out; out << std::setprecision(8);
    out << "{\"ok\":true,\"state\":\"completed\",\"panoramaPath\":" << quote(panorama.string())
        << ",\"thumbnailPath\":" << quote(thumbnail.string()) << ",\"width\":" << outputWidth
        << ",\"height\":" << outputWidth / 2 << ",\"report\":{\"method\":" << quote(model)
        << ",\"aiUsed\":" << (ai ? "true" : "false") << ",\"device\":\"Android CPU\",\"inputFrames\":" << inputCount
        << ",\"alignedFrames\":" << views.size() << ",\"matchedPairs\":" << edges.size()
        << ",\"classicalRecoveryPairs\":" << recoveredPairs
        << ",\"excludedFrames\":" << indicesJson(excluded) << ",\"coverage\":" << finalCoverage.sphereFraction
        << ",\"pixelCoverage\":" << finalCoverage.pixelFraction << ",\"largestHolePixels\":" << finalCoverage.largestHolePixels
        << ",\"largestHoleFraction\":" << finalCoverage.largestHoleFraction << ",\"alignmentErrorDegrees\":" << residuals.first
        << ",\"alignmentP95Degrees\":" << residuals.second << ",\"wrapMedianColorDifference\":" << wrapMedian
        << ",\"alignmentMedianPixels\":" << residuals.first * outputWidth / 360
        << ",\"alignmentP95Pixels\":" << residuals.second * outputWidth / 360
        << ",\"seamMethod\":\"periodic graph-cut + multiband\",\"generativeFill\":false,\"warnings\":"
        << stringsJson(warnings) << "}}";
    callbacks.publish(100, "panorama ready");
    return out.str();
}
}
