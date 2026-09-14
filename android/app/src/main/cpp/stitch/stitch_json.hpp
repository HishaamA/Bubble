#pragma once

#include "stitch_geometry.hpp"
#include "third_party/json.hpp"
#include <cmath>
#include <limits>

namespace bubble::stitch {
using Json = nlohmann::json;

// Android JSONObject uses standard JSON escapes (including \/), Unicode and null.
// OpenCV FileStorage is a configuration format, not a compatible JSON boundary.
inline Json parseJson(const std::string& input) {
    if (input.size() > 64 * 1024 * 1024)
        throw Failure("INVALID_JSON", "The panorama input metadata is too large.");
    try {
        auto value = Json::parse(input, [](int depth, Json::parse_event_t, Json&) {
            if (depth > 32) throw Failure("INVALID_JSON", "The panorama input metadata is nested too deeply.");
            return true;
        });
        if (!value.is_object()) throw Failure("INVALID_JSON", "The panorama input metadata must be a JSON object.");
        return value;
    } catch (const Json::exception&) {
        // Parser exception text may contain private filenames or photo metadata.
        throw Failure("INVALID_JSON", "The panorama input metadata contains invalid JSON.");
    }
}

inline const Json& field(const Json& object, const char* key) {
    static const Json absent;
    if (!object.is_object()) return absent;
    auto value = object.find(key);
    return value == object.end() ? absent : *value;
}
inline double number(const Json& node, double fallback = 0) {
    if (!node.is_number()) return fallback;
    double value = node.get<double>();
    return std::isfinite(value) ? value : fallback;
}
inline int integer(const Json& node, int fallback = 0) {
    double value = number(node, static_cast<double>(fallback));
    if (value < std::numeric_limits<int>::min() || value > std::numeric_limits<int>::max() ||
        std::trunc(value) != value) return fallback;
    return static_cast<int>(value);
}
inline bool boolean(const Json& node, bool fallback = false) {
    return node.is_boolean() ? node.get<bool>() : node.is_number() ? number(node) != 0 : fallback;
}
inline std::string text(const Json& node, const std::string& fallback = "") {
    return node.is_string() ? node.get<std::string>() : fallback;
}
}
