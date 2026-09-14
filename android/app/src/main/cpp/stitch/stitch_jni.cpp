#include "stitch_engine.hpp"
#include "stitch_unicode.hpp"
#include <jni.h>
#include <opencv2/core.hpp>
#include <mutex>
#include <memory>

namespace {
std::mutex jobMutex;
std::string utf8(JNIEnv* env, jstring value) {
    if (!value) return {};
    const jchar* bytes = env->GetStringChars(value, nullptr);
    if (!bytes) { env->ExceptionClear(); throw std::bad_alloc(); }
    auto release = [env,value](const jchar* data) { env->ReleaseStringChars(value,data); };
    std::unique_ptr<const jchar,decltype(release)> lease(bytes,release);
    std::u16string copy(bytes,bytes + env->GetStringLength(value));
    return bubble::stitch::standardUtf8(copy);
}
jstring javaString(JNIEnv* env, const std::string& value) {
    auto utf16 = bubble::stitch::javaUtf16(value);
    std::vector<jchar> characters(utf16.begin(),utf16.end());
    jstring result = env->NewString(characters.data(),static_cast<jsize>(characters.size()));
    if (!result) { env->ExceptionClear(); throw std::bad_alloc(); }
    return result;
}
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_simerfamily_kinsphere_panorama_stitch_NativePanoramaStitcher_stitch(
    JNIEnv* env, jclass, jstring manifest, jstring output, jstring matches, jint width, jobject callback) {
    using namespace bubble::stitch;
    std::unique_lock<std::mutex> lock(jobMutex, std::try_to_lock);
    if (!lock.owns_lock()) return env->NewStringUTF(errorJson("BUSY", "Another panorama is already being assembled.").c_str());
    std::string result;
    try {
        jmethodID progress = nullptr, cancelled = nullptr;
        if (callback) {
            jclass cls = env->GetObjectClass(callback);
            progress = env->GetMethodID(cls, "onProgress", "(ILjava/lang/String;)V");
            cancelled = env->GetMethodID(cls, "isCancelled", "()Z");
            env->DeleteLocalRef(cls);
            if (!progress || !cancelled || env->ExceptionCheck()) {
                env->ExceptionClear(); throw Failure("INVALID_CALLBACK", "The stitching progress callback is invalid.");
            }
        }
        Callbacks callbacks;
        int lastProgress = -1;
        std::string lastStage;
        callbacks.cancelled = [&] {
            if (!callback) return false;
            jboolean answer = env->CallBooleanMethod(callback, cancelled);
            if (env->ExceptionCheck()) { env->ExceptionClear(); throw Failure("CALLBACK_FAILED", "The cancellation callback failed."); }
            return answer == JNI_TRUE;
        };
        callbacks.progress = [&](int percent, const std::string& stage) {
            if (!callback) return;
            if (percent == lastProgress && stage == lastStage) return;
            lastProgress = percent; lastStage = stage;
            jstring label = env->NewStringUTF(stage.c_str());
            env->CallVoidMethod(callback, progress, percent, label); env->DeleteLocalRef(label);
            if (env->ExceptionCheck()) { env->ExceptionClear(); throw Failure("CALLBACK_FAILED", "The progress callback failed."); }
        };
        result = runStitch(utf8(env, manifest), utf8(env, output), utf8(env, matches), width, callbacks);
    } catch (const Failure& error) {
        result = errorJson(error.code, error.what(), error.report);
    } catch (const cv::Exception& error) {
        result = error.code == cv::Error::StsNoMem
            ? errorJson("MEMORY_LIMIT", "There was not enough memory. Retry with a smaller output width.")
            : errorJson("OPENCV_FAILED", std::string("Visual reconstruction failed: ") + error.what());
    } catch (const std::bad_alloc&) {
        result = errorJson("MEMORY_LIMIT", "There was not enough memory. Retry with a smaller output width.");
    } catch (const std::exception& error) {
        result = errorJson("STITCH_FAILED", error.what());
    }
    if (env->ExceptionCheck()) env->ExceptionClear();
    try { return javaString(env,result); }
    catch (const std::bad_alloc&) {
        return env->NewStringUTF("{\"state\":\"failed\",\"code\":\"out_of_memory\",\"error\":\"The panorama result could not be returned. Retry with a smaller output width.\"}");
    }
    catch (const std::exception&) {
        return env->NewStringUTF("{\"state\":\"failed\",\"code\":\"stitch_failed\",\"error\":\"The panorama result contains invalid text.\"}");
    }
}
