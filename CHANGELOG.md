# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries are derived from Conventional Commits.

## [Unreleased]

### Added

- Add Idempotency-Key middleware (`createIdempotency`) with sf-string key parsing, request fingerprinting, response replay, in-flight locking, RFC 9457 problem responses and a bounded `MemoryStore`.
- Initial project structure from the factory utility template.
