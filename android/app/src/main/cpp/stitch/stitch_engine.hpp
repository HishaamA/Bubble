#pragma once
#include "stitch_geometry.hpp"

namespace bubble::stitch {
// Thread-safe at this boundary; the Java coordinator should serialize jobs to bound memory.
std::string runStitch(const std::string& manifestJson, const std::string& outputDirectory,
    const std::string& matchesJson, int outputWidth, const Callbacks& callbacks);
std::string errorJson(const std::string& code, const std::string& message, const std::string& report = "");
}
