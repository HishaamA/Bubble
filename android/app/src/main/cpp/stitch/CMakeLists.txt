cmake_minimum_required(VERSION 3.22)
project(bubble_stitcher LANGUAGES CXX)

# Pass -DOpenCV_DIR=<OpenCV-android-sdk>/sdk/native/jni from Gradle.
# Link only the selected official SDK modules into our library. No Java OpenCV
# runtime is used; NativePanoramaStitcher must load only bubble_stitcher.
set(OpenCV_STATIC ON)
find_package(OpenCV 4.12 REQUIRED COMPONENTS core imgproc imgcodecs features2d calib3d stitching)
add_library(bubble_stitcher SHARED stitch_engine.cpp stitch_geometry.cpp stitch_jni.cpp)
target_compile_features(bubble_stitcher PRIVATE cxx_std_17)
target_include_directories(bubble_stitcher PRIVATE ${OpenCV_INCLUDE_DIRS})
target_link_libraries(bubble_stitcher PRIVATE ${OpenCV_LIBS} log)
target_compile_options(bubble_stitcher PRIVATE -Wall -Wextra -Werror=return-type)
target_link_options(bubble_stitcher PRIVATE "-Wl,-z,max-page-size=16384")

option(BUBBLE_STITCH_BUILD_TESTS "Build device-native geometry tests and stitch CLI" OFF)
if(BUBBLE_STITCH_BUILD_TESTS)
    add_executable(bubble_stitch_tests stitch_geometry_test.cpp stitch_geometry.cpp)
    target_compile_features(bubble_stitch_tests PRIVATE cxx_std_17)
    target_include_directories(bubble_stitch_tests PRIVATE ${OpenCV_INCLUDE_DIRS})
    target_link_libraries(bubble_stitch_tests PRIVATE ${OpenCV_LIBS})
    add_executable(bubble_stitch_cli stitch_cli.cpp stitch_engine.cpp stitch_geometry.cpp)
    target_compile_features(bubble_stitch_cli PRIVATE cxx_std_17)
    target_include_directories(bubble_stitch_cli PRIVATE ${OpenCV_INCLUDE_DIRS})
    target_link_libraries(bubble_stitch_cli PRIVATE ${OpenCV_LIBS})
endif()
