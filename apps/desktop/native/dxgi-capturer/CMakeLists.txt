# CMake build for the DXGI capturer (alternative to build.ps1).
#   cmake -S . -B build -G "Visual Studio 17 2022" -A x64
#   cmake --build build --config Release
# Output: build/Release/capturer.exe
cmake_minimum_required(VERSION 3.20)
project(dxgi_capturer CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(capturer main.cpp)
target_link_libraries(capturer PRIVATE d3d11 dxgi user32)

if (MSVC)
    target_compile_options(capturer PRIVATE /W3 /O2 /EHsc)
endif()
