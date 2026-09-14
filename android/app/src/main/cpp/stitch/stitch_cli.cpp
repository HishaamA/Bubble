#include "stitch_engine.hpp"
#include <opencv2/core.hpp>
#include <fstream>
#include <iostream>
#include <iterator>

std::string read(const char* path) {
    if (std::string(path) == "-") return {};
    std::ifstream file(path);
    if (!file) throw std::runtime_error("Input JSON file is unavailable");
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}

int main(int argc, char** argv) {
    if (argc != 5) {
        std::cerr << "Usage: bubble_stitch_cli manifest.json matches.json-or-- output-directory width\n";
        return 2;
    }
    using namespace bubble::stitch;
    try {
        int previousPercent = -1; std::string previousStage;
        Callbacks callbacks{[&](int percent, const std::string& stage) {
            if (percent == previousPercent && stage == previousStage) return;
            previousPercent = percent; previousStage = stage;
            std::cerr << percent << "% " << stage << '\n';
        }, {}};
        std::cout << runStitch(read(argv[1]),argv[3],read(argv[2]),std::stoi(argv[4]),callbacks) << '\n';
        return 0;
    } catch (const Failure& error) {
        std::cout << errorJson(error.code,error.what(),error.report) << '\n'; return 1;
    } catch (const cv::Exception& error) {
        std::cout << errorJson(error.code == cv::Error::StsNoMem ? "MEMORY_LIMIT" : "OPENCV_FAILED",error.what()) << '\n'; return 1;
    } catch (const std::bad_alloc&) {
        std::cout << errorJson("MEMORY_LIMIT","There was not enough memory. Retry with a smaller output width.") << '\n'; return 1;
    } catch (const std::exception& error) {
        std::cout << errorJson("STITCH_FAILED",error.what()) << '\n'; return 1;
    }
}
