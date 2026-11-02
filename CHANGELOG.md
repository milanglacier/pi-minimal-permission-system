# Changelog

## [1.5.1] - 2026-10-07

### Added

- `PI_MINIMAL_PERMISSION_SYSTEM_NONINTERACTIVE=1` blocks calls that need approval instead of showing a prompt that nobody can answer.

## [1.5.0] - 2026-10-06

### Added

- `PI_MINIMAL_PERMISSION_SYSTEM_YOLO=1` enables YOLO by default, and `--no-yolo` turns it off. Agent sessions started from a YOLO session inherit the setting.

## [1.4.1] - 2026-10-04

### Changed

- A blocked call's error names the target, the kind of block, and the matching rule with its status.

## [1.4.0] - 2026-10-02

### Added

- `codemode` rules match codemode scripts with esquery AST selectors.

## [1.3.2] - 2026-10-01

### Changed

- Supports Pi 1.x.

## [1.3.0] - 2026-09-21

### Breaking Changes

- Requires Pi 0.86 or newer.

## [1.2.0] - 2026-09-10

### Fixed

- Abort cancels an unanswered permission prompt without running the tool.

## [1.0.4] - 2026-05-13

### Added

- `/yolo` and `--yolo` bypass all permission checks.

## [1.0.1] - 2026-05-13

### Added

- Initial release. Enforces `allow`, `ask`, and `deny` rules for `bash`, `read`, `edit`, and `write` from global and project `permissions.jsonc` files.
