#include "stitch_geometry.hpp"
#include <opencv2/calib3d.hpp>
#include <opencv2/imgproc.hpp>
#include <algorithm>
#include <cmath>
#include <numeric>
#include <random>
#include <set>
#include <tuple>

namespace bubble::stitch {
void Callbacks::check() const {
    if (cancelled && cancelled()) throw Failure("CANCELLED", "Panorama processing was cancelled.");
}
void Callbacks::publish(int percent, const std::string& stage) const {
    check();
    if (progress) progress(percent, stage);
}

Coverage measureCoverage(const cv::Mat& mask) {
    double observed = 0, total = 0;
    for (int y = 0; y < mask.rows; ++y) {
        double weight = std::cos((0.5 - (y + 0.5) / mask.rows) * CV_PI);
        observed += weight * cv::countNonZero(mask.row(y)); total += weight * mask.cols;
    }
    Coverage result;
    result.sphereFraction = observed / total;
    result.pixelFraction = cv::countNonZero(mask) / static_cast<double>(mask.total());
    cv::Mat missing, labels, stats, centroids;
    cv::compare(mask, 0, missing, cv::CMP_EQ);
    if (!cv::countNonZero(missing)) return result;
    int count = cv::connectedComponentsWithStats(missing, labels, stats, centroids, 8, CV_32S);
    std::vector<int> parent(count), area(count, 0);
    std::iota(parent.begin(), parent.end(), 0);
    auto root = [&](int value) {
        while (parent[value] != value) { parent[value] = parent[parent[value]]; value = parent[value]; }
        return value;
    };
    for (int y = 0; y < mask.rows; ++y) {
        int a = labels.at<int>(y, 0);
        if (!a) continue;
        for (int offset = -1; offset <= 1; ++offset) {
            int row = y + offset;
            if (row < 0 || row >= mask.rows) continue;
            int b = labels.at<int>(row, mask.cols - 1);
            if (b) parent[root(b)] = root(a);
        }
    }
    for (int label = 1; label < count; ++label) area[root(label)] += stats.at<int>(label, cv::CC_STAT_AREA);
    result.largestHolePixels = *std::max_element(area.begin(), area.end());
    result.largestHoleFraction = result.largestHolePixels / static_cast<double>(mask.total());
    return result;
}

double percentile(std::vector<double> values, double fraction) {
    if (values.empty()) return 0;
    std::sort(values.begin(), values.end());
    double index = std::clamp(fraction, 0.0, 1.0) * (values.size() - 1);
    size_t lo = static_cast<size_t>(index), hi = std::min(lo + 1, values.size() - 1);
    return values[lo] + (index - lo) * (values[hi] - values[lo]);
}

double angleDegrees(const cv::Vec3d& a, const cv::Vec3d& b) {
    return std::atan2(cv::norm(a.cross(b)), a.dot(b)) * 180.0 / CV_PI;
}
cv::Matx33d expRotation(const cv::Vec3d& radians) {
    cv::Matx33d rotation;
    cv::Rodrigues(radians, rotation);
    return rotation;
}
cv::Vec3d logRotation(const cv::Matx33d& rotation) {
    cv::Vec3d radians;
    cv::Rodrigues(rotation, radians);
    return radians;
}
cv::Vec3d pixelRay(const View& v, const cv::Point2d& pixel) {
    cv::Vec3d ray((pixel.x - v.cx) / v.fx, -(pixel.y - v.cy) / v.fy, 1);
    return ray / cv::norm(ray);
}
cv::Matx33d fitRotation(const std::vector<cv::Vec3d>& source,
                       const std::vector<cv::Vec3d>& target) {
    cv::Matx33d covariance = cv::Matx33d::zeros();
    for (size_t k = 0; k < source.size(); ++k) covariance += target[k] * source[k].t();
    cv::Mat w, u, vt;
    cv::SVD::compute(cv::Mat(covariance), w, u, vt);
    cv::Mat correction = cv::Mat::eye(3, 3, CV_64F);
    correction.at<double>(2, 2) = cv::determinant(u * vt) < 0 ? -1 : 1;
    cv::Mat result = u * correction * vt;
    return cv::Matx33d(result);
}

bool validatePair(const std::vector<View>& views, int i, int j,
    const std::vector<cv::Point2d>& input0, const std::vector<cv::Point2d>& input1,
    Edge& edge, const Callbacks& callbacks) {
    if (input0.size() != input1.size() || input0.size() < 12) return false;
    const View &a = views.at(i), &b = views.at(j);
    std::vector<cv::Point2d> points0, points1;
    std::vector<cv::Vec3d> rays0, rays1;
    const double scale0 = 1024.0 / std::max(a.width, a.height);
    const double scale1 = 1024.0 / std::max(b.width, b.height);
    for (size_t k = 0; k < input0.size(); ++k) {
        const auto p = input0[k], q = input1[k];
        if (!std::isfinite(p.x) || !std::isfinite(p.y) || !std::isfinite(q.x) || !std::isfinite(q.y) ||
            p.x < 0 || p.y < 0 || q.x < 0 || q.y < 0 ||
            p.x >= a.width || p.y >= a.height || q.x >= b.width || q.y >= b.height) continue;
        auto r0 = pixelRay(a, p), r1 = pixelRay(b, q);
        if (a.hasPose && b.hasPose && angleDegrees(a.prior * r0, b.prior * r1) > 24) continue;
        points0.push_back(p * scale0); points1.push_back(q * scale1);
        rays0.push_back(r0); rays1.push_back(r1);
    }
    if (points0.size() < 12) return false;
    cv::Mat hInliers;
    cv::Mat h = cv::findHomography(points0, points1, cv::RANSAC, 3.5, hInliers, 1500, 0.995);
    if (h.empty() || cv::countNonZero(hInliers) < 12) return false;
    std::vector<cv::Vec3d> filtered0, filtered1;
    for (int k = 0; k < hInliers.rows; ++k) if (hInliers.at<uchar>(k)) {
        filtered0.push_back(rays0[k]); filtered1.push_back(rays1[k]);
    }
    rays0.swap(filtered0); rays1.swap(filtered1);
    std::mt19937 random(static_cast<unsigned>(i * 1009 + j));
    std::uniform_int_distribution<int> choose(0, static_cast<int>(rays0.size()) - 1);
    std::vector<int> best;
    for (int iteration = 0; iteration < 140; ++iteration) {
        if (iteration % 20 == 0) callbacks.check();
        int x = choose(random), y = choose(random), z = choose(random);
        if (x == y || y == z || x == z) continue;
        if (cv::norm((rays1[y] - rays1[x]).cross(rays1[z] - rays1[x])) < 1e-5) continue;
        auto rotation = fitRotation({rays1[x], rays1[y], rays1[z]}, {rays0[x], rays0[y], rays0[z]});
        std::vector<int> selected;
        for (size_t k = 0; k < rays0.size(); ++k)
            if (angleDegrees(rotation * rays1[k], rays0[k]) < 1.25) selected.push_back(static_cast<int>(k));
        if (selected.size() > best.size()) best.swap(selected);
    }
    if (best.size() < 12 || best.size() < rays0.size() * 0.35) return false;
    std::vector<cv::Vec3d> source, target;
    for (int k : best) { source.push_back(rays1[k]); target.push_back(rays0[k]); }
    auto rotation = fitRotation(source, target);
    best.clear();
    std::vector<double> errors;
    for (size_t k = 0; k < rays0.size(); ++k) {
        double error = angleDegrees(rotation * rays1[k], rays0[k]);
        if (error < 1.25) { best.push_back(static_cast<int>(k)); errors.push_back(error); }
    }
    if (best.size() < 12) return false;
    cv::Vec2d mean(0, 0), variance(0, 0);
    for (int k : best) mean += cv::Vec2d(rays0[k][0], rays0[k][1]);
    mean /= static_cast<double>(best.size());
    for (int k : best) for (int c = 0; c < 2; ++c) variance[c] += std::pow(rays0[k][c] - mean[c], 2);
    if (std::sqrt(std::min(variance[0], variance[1]) / best.size()) < 0.025) return false;
    edge.i = i; edge.j = j; edge.rotation = rotation;
    edge.count = static_cast<int>(best.size()); edge.medianError = percentile(errors, 0.5);
    edge.rays0.clear(); edge.rays1.clear();
    const int kept = std::min(100, edge.count);
    for (int k = 0; k < kept; ++k) {
        int index = best[static_cast<size_t>(k) * best.size() / kept];
        edge.rays0.push_back(rays0[index]); edge.rays1.push_back(rays1[index]);
    }
    return true;
}

std::vector<std::vector<int>> components(int count, const std::vector<Edge>& edges) {
    std::vector<std::vector<int>> neighbors(count), groups;
    for (const auto& e : edges) { neighbors[e.i].push_back(e.j); neighbors[e.j].push_back(e.i); }
    std::vector<bool> seen(count, false);
    for (int i = 0; i < count; ++i) if (!seen[i]) {
        std::vector<int> group, queue{i}; seen[i] = true;
        for (size_t k = 0; k < queue.size(); ++k) {
            int current = queue[k]; group.push_back(current);
            for (int next : neighbors[current]) if (!seen[next]) { seen[next] = true; queue.push_back(next); }
        }
        groups.push_back(std::move(group));
    }
    std::sort(groups.begin(), groups.end(), [](const auto& a, const auto& b) { return a.size() > b.size(); });
    return groups;
}

std::vector<std::pair<int,int>> recoveryPairs(const std::vector<View>& views,
    const std::vector<Edge>& edges) {
    if (!std::all_of(views.begin(),views.end(),[](const View& view){return view.hasPose;})) return {};
    auto groups = components(static_cast<int>(views.size()),edges);
    std::vector<int> group(views.size()), degree(views.size(),0), attempts(views.size(),0);
    for (size_t i = 0; i < groups.size(); ++i) for (int frame : groups[i]) group[frame] = static_cast<int>(i);
    std::set<std::pair<int,int>> existing;
    for (const auto& edge : edges) {
        ++degree[edge.i]; ++degree[edge.j]; existing.emplace(std::min(edge.i,edge.j),std::max(edge.i,edge.j));
    }
    std::vector<std::tuple<double,int,int>> candidates;
    for (size_t i = 0; i < views.size(); ++i) for (size_t j = i+1; j < views.size(); ++j) {
        if (existing.count({static_cast<int>(i),static_cast<int>(j)})) continue;
        if (degree[i] >= 2 && degree[j] >= 2 && group[i] == group[j]) continue;
        double angle = angleDegrees(views[i].prior * cv::Vec3d(0,0,1),views[j].prior * cv::Vec3d(0,0,1));
        if (angle < 85) candidates.emplace_back(angle,static_cast<int>(i),static_cast<int>(j));
    }
    std::sort(candidates.begin(),candidates.end());
    std::vector<std::pair<int,int>> selected;
    for (auto [angle,i,j] : candidates) {
        (void)angle;
        if (attempts[i] >= 4 || attempts[j] >= 4) continue;
        ++attempts[i]; ++attempts[j]; selected.emplace_back(i,j);
        if (selected.size() >= 96) break;
    }
    return selected;
}

void bootstrap(std::vector<View>& views, const std::vector<Edge>& edges) {
    std::vector<int> order(edges.size()); std::iota(order.begin(), order.end(), 0);
    std::sort(order.begin(), order.end(), [&](int a, int b) {
        return edges[a].count / (0.1 + edges[a].medianError) > edges[b].count / (0.1 + edges[b].medianError);
    });
    std::vector<bool> known(views.size(), false); known[0] = true;
    views[0].rotation = cv::Matx33d::eye();
    for (size_t iteration = 0; iteration < views.size(); ++iteration) for (int index : order) {
        const auto& e = edges[index];
        if (known[e.i] && !known[e.j]) { views[e.j].rotation = views[e.i].rotation * e.rotation; known[e.j] = true; }
        if (known[e.j] && !known[e.i]) { views[e.i].rotation = views[e.j].rotation * e.rotation.t(); known[e.i] = true; }
    }
    if (std::find(known.begin(), known.end(), false) != known.end())
        throw Failure("DISCONNECTED_GEOMETRY", "The photos do not connect into one sphere. Add overlapping views.");
}

namespace {
cv::Matx33d skew(const cv::Vec3d& v) {
    return {0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0};
}
double objective(const std::vector<View>& views, const std::vector<Edge>& edges) {
    constexpr double scale = 0.006;
    double cost = 0;
    for (const auto& e : edges) for (size_t k = 0; k < e.rays0.size(); ++k) {
        auto r = views[e.i].rotation * e.rays0[k] - views[e.j].rotation * e.rays1[k];
        cost += 2 * scale * scale * (std::sqrt(1 + r.dot(r) / (scale * scale)) - 1);
    }
    for (size_t i = 1; i < views.size(); ++i) if (views[i].hasPose) {
        auto delta = logRotation(views[i].rotation * views[i].prior.t());
        cost += 0.0064 * delta.dot(delta);
    }
    return cost;
}
}

std::pair<double, double> refineRotations(std::vector<View>& views,
    const std::vector<Edge>& edges, const Callbacks& callbacks) {
    const int variables = (static_cast<int>(views.size()) - 1) * 3;
    double lambda = 1e-4, cost = objective(views, edges);
    for (int iteration = 0; iteration < 60; ++iteration) {
        callbacks.publish(25 + iteration / 6, "refining camera geometry");
        cv::Mat normal = cv::Mat::zeros(variables, variables, CV_64F);
        cv::Mat gradient = cv::Mat::zeros(variables, 1, CV_64F);
        for (const auto& e : edges) for (size_t k = 0; k < e.rays0.size(); ++k) {
            auto a = views[e.i].rotation * e.rays0[k], b = views[e.j].rotation * e.rays1[k];
            auto residual = a - b;
            const double weight = 1 / std::sqrt(1 + residual.dot(residual) / (0.006 * 0.006));
            cv::Matx33d jacobian[2] = {-skew(a), skew(b)};
            int ids[2] = {e.i, e.j};
            for (int side = 0; side < 2; ++side) if (ids[side] > 0) {
                int offset = (ids[side] - 1) * 3;
                auto g = jacobian[side].t() * residual * weight;
                for (int r = 0; r < 3; ++r) gradient.at<double>(offset + r) += g[r];
                for (int other = 0; other < 2; ++other) if (ids[other] > 0) {
                    auto block = jacobian[side].t() * jacobian[other] * weight;
                    int col = (ids[other] - 1) * 3;
                    for (int r = 0; r < 3; ++r) for (int c = 0; c < 3; ++c)
                        normal.at<double>(offset + r, col + c) += block(r, c);
                }
            }
        }
        for (size_t i = 1; i < views.size(); ++i) if (views[i].hasPose) {
            auto delta = logRotation(views[i].rotation * views[i].prior.t());
            for (int c = 0; c < 3; ++c) {
                int index = (static_cast<int>(i) - 1) * 3 + c;
                gradient.at<double>(index) += 0.0064 * delta[c];
                normal.at<double>(index, index) += 0.0064;
            }
        }
        for (int i = 0; i < variables; ++i) normal.at<double>(i, i) += lambda;
        cv::Mat step;
        if (!cv::solve(normal, -gradient, step, cv::DECOMP_CHOLESKY)) { lambda *= 10; continue; }
        std::vector<View> candidate = views;
        double largestStep = 0;
        bool acceptable = true;
        for (size_t i = 1; i < views.size(); ++i) {
            int offset = (static_cast<int>(i) - 1) * 3;
            cv::Vec3d delta(step.at<double>(offset), step.at<double>(offset + 1), step.at<double>(offset + 2));
            double length = cv::norm(delta);
            if (length > 0.06) delta *= 0.06 / length;
            largestStep = std::max(largestStep, cv::norm(delta));
            candidate[i].rotation = expRotation(delta) * views[i].rotation;
            if (views[i].hasPose && cv::norm(logRotation(candidate[i].rotation * views[i].prior.t())) > 0.35)
                acceptable = false;
        }
        double candidateCost = acceptable ? objective(candidate, edges) : INFINITY;
        if (candidateCost < cost) {
            double improvement = cost - candidateCost;
            views.swap(candidate); cost = candidateCost; lambda = std::max(1e-8, lambda * 0.4);
            if (largestStep < 1e-6 || improvement < 1e-9) break;
        } else {
            lambda *= 6;
            if (lambda > 1e8) break;
        }
    }
    std::vector<double> errors;
    for (const auto& e : edges) for (size_t k = 0; k < e.rays0.size(); ++k)
        errors.push_back(angleDegrees(views[e.i].rotation * e.rays0[k], views[e.j].rotation * e.rays1[k]));
    return {percentile(errors, 0.5), percentile(errors, 0.95)};
}
}
