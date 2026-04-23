cmake_minimum_required(VERSION 3.24)
project(icc-flow-wasm VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "This project must be configured with emcmake (emscripten).")
endif()

# ── Locate iccDEV source ────────────────────────────────────────────────────
set(ICCDEV_ROOT "/home/colour/code/iccdev" CACHE PATH "Root of iccDEV source tree")
set(ICCPROFLIB_DIR "${ICCDEV_ROOT}/IccProfLib")

if(NOT EXISTS "${ICCPROFLIB_DIR}/IccProfile.h")
  message(FATAL_ERROR "IccProfLib headers not found at ${ICCPROFLIB_DIR}")
endif()

set(ICCPROFLIB_SOURCES
  IccApplyBPC.cpp IccArrayBasic.cpp IccArrayFactory.cpp IccCAM.cpp IccCmm.cpp
  IccConvertUTF.cpp IccEncoding.cpp IccEnvVar.cpp IccEval.cpp IccIO.cpp
  IccMatrixMath.cpp IccMpeACS.cpp IccMpeBasic.cpp IccMpeCalc.cpp IccMpeFactory.cpp
  IccMpeSpectral.cpp IccPrmg.cpp IccPcc.cpp IccProfile.cpp IccSolve.cpp
  IccSparseMatrix.cpp IccStructBasic.cpp IccStructFactory.cpp IccTagBasic.cpp
  IccTagComposite.cpp IccTagDict.cpp IccTagEmbedIcc.cpp IccTagFactory.cpp
  IccTagLut.cpp IccTagMPE.cpp IccTagProfSeqId.cpp IccUtil.cpp IccXformFactory.cpp
  IccMD5.cpp IccCmmSearch.cpp)
list(TRANSFORM ICCPROFLIB_SOURCES PREPEND "${ICCPROFLIB_DIR}/")

set(ICCPROFLIB_VERSION_STRING "${PROJECT_VERSION}-wasm")
configure_file(
  "${ICCPROFLIB_DIR}/IccProfLibVer.h.in"
  "${CMAKE_CURRENT_BINARY_DIR}/generated/IccProfLibVer.h"
  @ONLY)

# ── nlohmann/json (host system header) ──────────────────────────────────────
find_path(NLOHMANN_JSON_SRC
  NAMES nlohmann/json.hpp
  PATHS /usr/include /usr/local/include
  NO_CMAKE_FIND_ROOT_PATH
  NO_DEFAULT_PATH)
if(NOT NLOHMANN_JSON_SRC)
  message(FATAL_ERROR "nlohmann/json.hpp not found — install nlohmann-json3-dev")
endif()
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/third-party")
file(CREATE_LINK
  "${NLOHMANN_JSON_SRC}/nlohmann"
  "${CMAKE_CURRENT_BINARY_DIR}/third-party/nlohmann"
  SYMBOLIC)
set(NLOHMANN_JSON_INCLUDE_DIR "${CMAKE_CURRENT_BINARY_DIR}/third-party")

# ── libtiff via FetchContent ────────────────────────────────────────────────
# Emscripten has no official libtiff port, so we vendor it. Turn off everything
# we don't need — we're targeting uncompressed or LZW-compressed CMYK TIFFs as
# the common prepress case. JPEG-in-TIFF, Zstd/WebP, ZIP/Deflate all ship off.
include(FetchContent)

# libtiff uses these cache vars (or equivalents) to gate features; set them
# before FetchContent_MakeAvailable so they take effect at configure time.
set(BUILD_SHARED_LIBS   OFF CACHE BOOL "" FORCE)
set(tiff-tools          OFF CACHE BOOL "" FORCE)
set(tiff-tests          OFF CACHE BOOL "" FORCE)
set(tiff-contrib        OFF CACHE BOOL "" FORCE)
set(tiff-docs           OFF CACHE BOOL "" FORCE)
set(tiff-deprecated     OFF CACHE BOOL "" FORCE)
set(tiff-install        OFF CACHE BOOL "" FORCE)
set(cxx                 OFF CACHE BOOL "" FORCE)
set(libdeflate          OFF CACHE BOOL "" FORCE)
set(zlib                OFF CACHE BOOL "" FORCE)
set(pixarlog            OFF CACHE BOOL "" FORCE)
set(jpeg                OFF CACHE BOOL "" FORCE)
set(old-jpeg            OFF CACHE BOOL "" FORCE)
set(jbig                OFF CACHE BOOL "" FORCE)
set(lzma                OFF CACHE BOOL "" FORCE)
set(zstd                OFF CACHE BOOL "" FORCE)
set(webp                OFF CACHE BOOL "" FORCE)
# Keep: lzw (compression we request above), packbits (cheap), ccitt (default on).

FetchContent_Declare(
  tiff
  GIT_REPOSITORY https://gitlab.com/libtiff/libtiff.git
  # v4.7.1 (Dec 2024) rolls up fixes for CVE-2024-7006, CVE-2023-6277, and
  # several TIFFReadDirectory bounds bugs that matter when the app ingests
  # arbitrary user TIFFs. Impact is sandboxed by the wasm VM, but keeping
  # this current avoids user-visible crashes on crafted inputs.
  GIT_TAG        v4.7.1
  GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(tiff)

# ── iccflow target ──────────────────────────────────────────────────────────
add_executable(iccflow flow-wrapper.cpp ${ICCPROFLIB_SOURCES})

target_include_directories(iccflow PRIVATE
  "${ICCPROFLIB_DIR}"
  "${CMAKE_CURRENT_BINARY_DIR}/generated"
  "${NLOHMANN_JSON_INCLUDE_DIR}")

# libtiff's CMake exposes the static target as TIFF::tiff; it carries its own
# INTERFACE include dirs so <tiffio.h> resolves automatically.
target_link_libraries(iccflow PRIVATE TIFF::tiff)

target_compile_options(iccflow PRIVATE
  -O3
  -fexceptions
  -Wno-deprecated-declarations)

target_link_options(iccflow PRIVATE
  -O3
  -fexceptions
  -lembind
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createIccFlowModule
  -sENVIRONMENT=web,worker,node
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=64MB
  -sMAXIMUM_MEMORY=1024MB
  -sSTACK_SIZE=1MB
  -sDYNAMIC_EXECUTION=0
  -sEXPORTED_RUNTIME_METHODS=getExceptionMessage,decrementExceptionRefcount
  # libtiff's mem-I/O expects POSIX stdio — keep MEMFS on.
  -sFORCE_FILESYSTEM=1)

set_target_properties(iccflow PROPERTIES SUFFIX ".mjs")
