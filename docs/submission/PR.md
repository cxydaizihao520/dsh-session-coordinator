## Summary

Add one bilingual session entry for a plugin that finds, reads and creates independent DeepSeek Harness sessions and shares context within an approved scope.

## Evidence

- The repository is public, has the dsh-plugin topic, and declares dsh.bundle.patch with the included patch file.
- Version 0.2.20 is a preview. A clean source build and official installer check passed, and the built plugin registered 26 tools in smoke tests. Real desktop testing covered loading the plugin and starting two native jobs in one session. See the [published acceptance scope](https://github.com/cxydaizihao520/dsh-session-coordinator/blob/main/docs/ACCEPTANCE.md) for the remaining cases.
- The proposed YAML passed the upstream entry validator. The entry focuses on independent session discovery, shared context and communication within an approved scope. Functional overlap with existing entries is for maintainer review.

## Merge Danger

The listing entry can be corrected or removed independently. Merging makes the plugin discoverable in the catalog.
