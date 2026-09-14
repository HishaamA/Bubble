#pragma once

#include "stitch_geometry.hpp"
#include <codecvt>
#include <locale>

namespace bubble::stitch {
// JNI GetStringUTFChars uses modified UTF-8, which is not valid JSON UTF-8 for
// supplementary Unicode characters. Convert Java UTF-16 explicitly instead.
inline std::string standardUtf8(const std::u16string& input) {
    try { return std::wstring_convert<std::codecvt_utf8_utf16<char16_t>,char16_t>{}.to_bytes(input); }
    catch (const std::range_error&) { throw Failure("INVALID_TEXT", "The panorama metadata contains invalid Unicode."); }
}
inline std::u16string javaUtf16(const std::string& input) {
    try { return std::wstring_convert<std::codecvt_utf8_utf16<char16_t>,char16_t>{}.from_bytes(input); }
    catch (const std::range_error&) { throw Failure("INVALID_TEXT", "The panorama result contains invalid Unicode."); }
}
}
