## Summary

Add a session plugin for approved collaboration between independent DeepSeek Harness main sessions, including multi-round tasks, information sharing, correlated results, task controls and local diagnostic export.

```diff
 data/plugins/
+  cxydaizihao520__dsh-session-coordinator.yml
```

One bilingual entry under session. No generated README or other plugin entry changes.

## Evidence

- **Before:** the checked upstream listing has no entry for this repository. **After:** the proposed single YAML passes the upstream readEntries / validateEntries implementation.
- Public source version 0.2.15 is available at commit [db824e2](https://github.com/cxydaizihao520/dsh-session-coordinator/commit/db824e27c9ff2315e6dd0216aef665a4cf9f96a6). The repository is public, unarchived, more than one day old and has the required dsh-plugin topic. Its dsh.bundle.patch resolves to the included patch.
- Official installation from that exact GitHub commit, prepare build and native registration of all 24 declared tools passed in an isolated macOS / Harness 0.2.1-rc.5 environment. The build output and client matched the previously accepted artifact.
- Real native web testing covered two sequential calculation/review exchanges after one scope approval, independent session history, completed task/scope states, rejection without dispatch, diagnostic download and a quiet terminal state. Upgrade from 0.2.14 retained history without replaying completed work. See the repository's [acceptance scope](https://github.com/cxydaizihao520/dsh-session-coordinator/blob/db824e27c9ff2315e6dd0216aef665a4cf9f96a6/docs/ACCEPTANCE.md).
- Public default checks passed with eight private-history client replays explicitly skipped and ten private trace-audit cases outside the default suite. Windows/Linux, every cancellation/recovery branch and complete Codex parity are not claimed. No private logs, screenshots, account metadata or npm publication are attached or implied.
- Compared with existing session-bridge entries, this submission emphasizes approved objectives/members/budgets, tracked review rounds and persisted task results. Functional overlap remains for maintainer review; no exclusivity is claimed.

## Merge Danger

**Door:** two-way.

The listing entry can be corrected or removed without changing user data.

**Blast Radius:** listing.

Merging increases discoverability; it does not publish the package or certify security, every model or every host platform.
