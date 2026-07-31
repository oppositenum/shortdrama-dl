# Changelog

## [1.1.0](https://github.com/oppositenum/shortdrama-dl/compare/v1.0.0...v1.1.0) (2026-07-31)


### Features

* **ci:** publish separate arm64/x64 macOS DMGs alongside universal ([74dfa55](https://github.com/oppositenum/shortdrama-dl/commit/74dfa5521979f03ba1d8d81711e20491a256e6d4))
* **ui:** remember the last-entered link, save dir, and other form fields ([cf8bffb](https://github.com/oppositenum/shortdrama-dl/commit/cf8bffb17e1f87125dece5ae35f47af3ba8555d6))


### Bug Fixes

* **ci:** look up draft releases with gh release view, not the tags API ([ab98bb5](https://github.com/oppositenum/shortdrama-dl/commit/ab98bb51e18f5b2d477ee29af24dcc99617024b4))
* **ci:** rename release assets to an ASCII slug before upload ([e07ec80](https://github.com/oppositenum/shortdrama-dl/commit/e07ec8009aea78056223bd34095de3d28b003f12))

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
