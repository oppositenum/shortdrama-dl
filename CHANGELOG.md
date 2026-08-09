# Changelog

## [1.6.0](https://github.com/oppositenum/shortdrama-dl/compare/v1.5.1...v1.6.0) (2026-08-09)


### Features

* support actor/character pages as multi-series lists ([#19](https://github.com/oppositenum/shortdrama-dl/issues/19)) ([22451bd](https://github.com/oppositenum/shortdrama-dl/commit/22451bda04874f1cb5d5adfccf59822ab161df83))

## [1.5.1](https://github.com/oppositenum/shortdrama-dl/compare/v1.5.0...v1.5.1) (2026-08-04)


### Bug Fixes

* **api:** retry CDN downloads in place and resume from the partial file ([dee47fa](https://github.com/oppositenum/shortdrama-dl/commit/dee47faa34896e10875d51bed6c4bc058caa76f8))

## [1.5.0](https://github.com/oppositenum/shortdrama-dl/compare/v1.4.0...v1.5.0) (2026-08-04)


### Features

* **offline:** sign X-Khronos and X-Gorgon in pure Python, no emulator at all ([9cee1eb](https://github.com/oppositenum/shortdrama-dl/commit/9cee1ebcdabebf0689944b28e85ed9356ffb63ac))

## [1.4.0](https://github.com/oppositenum/shortdrama-dl/compare/v1.3.0...v1.4.0) (2026-08-03)


### Features

* **notify:** push a Bark notification per finished series and on errors ([a55d4ec](https://github.com/oppositenum/shortdrama-dl/commit/a55d4ec7a9efa0473ae5dc74048841a8450179db))

## [1.3.0](https://github.com/oppositenum/shortdrama-dl/compare/v1.2.2...v1.3.0) (2026-08-03)


### Features

* **ui:** collapse the settings card and stop the log from yanking to bottom ([c922e0b](https://github.com/oppositenum/shortdrama-dl/commit/c922e0be506fd3857197d54c3c939e873d918317))
* **ui:** collapsible settings card and non-intrusive log scrolling ([bbe17b0](https://github.com/oppositenum/shortdrama-dl/commit/bbe17b02703db313276a2c12fec276857b79bfab))

## [1.2.2](https://github.com/oppositenum/shortdrama-dl/compare/v1.2.1...v1.2.2) (2026-08-01)


### Bug Fixes

* **api:** repair the 110001 signing fallback and stop the retry storm ([#8](https://github.com/oppositenum/shortdrama-dl/issues/8)) ([715e4f4](https://github.com/oppositenum/shortdrama-dl/commit/715e4f41171d54c7085335222d03defca7cd1a33))

## [1.2.1](https://github.com/oppositenum/shortdrama-dl/compare/v1.2.0...v1.2.1) (2026-08-01)


### Bug Fixes

* locate a real JDK on macOS and stop advertising the wrong grab mode ([#6](https://github.com/oppositenum/shortdrama-dl/issues/6)) ([3b74448](https://github.com/oppositenum/shortdrama-dl/commit/3b74448ae7f1983b9e44003ddac53c84c7fbb42b))

## [1.2.0](https://github.com/oppositenum/shortdrama-dl/compare/v1.1.0...v1.2.0) (2026-08-01)


### Features

* **api:** add pure-protocol download mode that needs no Android device ([990cba1](https://github.com/oppositenum/shortdrama-dl/commit/990cba146362d96c0714bda52e791cf4bb5ab7cf))
* **api:** pure-protocol download mode with no Android device required ([543b8e9](https://github.com/oppositenum/shortdrama-dl/commit/543b8e98192f2b7786ab403135ca228aee032075))
* **log:** report how long each series took end to end ([398089a](https://github.com/oppositenum/shortdrama-dl/commit/398089af928f53e5f79c4085bfde381846404ad0))

## [1.1.0](https://github.com/oppositenum/shortdrama-dl/compare/v1.0.0...v1.1.0) (2026-07-31)


### Features

* **ci:** publish separate arm64/x64 macOS DMGs alongside universal ([74dfa55](https://github.com/oppositenum/shortdrama-dl/commit/74dfa5521979f03ba1d8d81711e20491a256e6d4))
* **ui:** remember the last-entered link, save dir, and other form fields ([cf8bffb](https://github.com/oppositenum/shortdrama-dl/commit/cf8bffb17e1f87125dece5ae35f47af3ba8555d6))


### Bug Fixes

* **ci:** exempt fsevents.node from the single-arch verification ([c3af5ee](https://github.com/oppositenum/shortdrama-dl/commit/c3af5eed5367d32fe47ea93697c9c14cd5deed01))
* **ci:** look up draft releases with gh release view, not the tags API ([ab98bb5](https://github.com/oppositenum/shortdrama-dl/commit/ab98bb51e18f5b2d477ee29af24dcc99617024b4))
* **ci:** rename release assets to an ASCII slug before upload ([e07ec80](https://github.com/oppositenum/shortdrama-dl/commit/e07ec8009aea78056223bd34095de3d28b003f12))
* **docs:** correct README cross-language links after the file swap ([1b8f71a](https://github.com/oppositenum/shortdrama-dl/commit/1b8f71aec95f1689f4a3a1d6254a7eb97915f690))

## 1.0.0 (2026-07-31)


### Features

* initial public release of the short-drama downloader ([aa82626](https://github.com/oppositenum/shortdrama-dl/commit/aa82626bb5ab8570d6f28f9a3e0d2752ad95269b))
* **ui:** add a read-only environment check panel ([ab5ac5d](https://github.com/oppositenum/shortdrama-dl/commit/ab5ac5d9c3ef59230d7d4dda093d6b467ddb47e5))
* **ui:** add a synopsis detail mode and a graceful stop button ([3ee6b93](https://github.com/oppositenum/shortdrama-dl/commit/3ee6b93c338623d7d4669d7c60bb9a3cbd22ccef))
* **web:** save the series synopsis next to the cover ([d159759](https://github.com/oppositenum/shortdrama-dl/commit/d15975987284be914a3d288840a9e983265fc269))


### Bug Fixes

* **grab:** detect search box/button structurally, not by obfuscated id ([80a786b](https://github.com/oppositenum/shortdrama-dl/commit/80a786bd65d35a4462203331ca853874e5bbdcd3))
* **grab:** locate the more-menu button structurally, not by fixed ratio ([fdd678f](https://github.com/oppositenum/shortdrama-dl/commit/fdd678fe7c3eb3dbb739a67995be21afdbb3a2b1))
* **grab:** make App capture hold up over long batch runs ([bd15e03](https://github.com/oppositenum/shortdrama-dl/commit/bd15e035717d5daf6fe887fb16bba3ec48889b00))
* **grab:** match both download-entry labels across app versions ([451aef0](https://github.com/oppositenum/shortdrama-dl/commit/451aef07a96ee023669ca8c50a53f9d9ed62f556))
* make the test suite and the capture script work on Windows ([b2258c2](https://github.com/oppositenum/shortdrama-dl/commit/b2258c2783b2bdc0dd2fc9b7aa011d11f63565cf))
* **windows:** repair the AVD setup script's broken variable interpolation ([59e86b0](https://github.com/oppositenum/shortdrama-dl/commit/59e86b0818f430424b94c79e3503a971c188cb44))

## Changelog

Notable changes to shortdrama-dl are recorded here. Release Please updates this file from Conventional Commit messages when it prepares a release.
