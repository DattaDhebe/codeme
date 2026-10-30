# Finding relevant code in a large repository

CodeMe builds a small, fresh navigation map before an Agent task. The local model can request another map with the `repository_context` tool when it needs a narrower view. This helps it find likely implementation files, related tests, and dependencies without filling its context window with a directory listing.

The map contains paths, ranking reasons, approximate symbol locations, and applicable `AGENTS.md` paths. It does not contain source bodies. CodeMe labels this metadata as untrusted evidence and puts the automatic map before the original task. If the model's context window is tight, the map is removed before the task or project instructions.

For broad architecture questions, CodeMe also includes small excerpts from selected root README files, manifests, or entry points. Nested source still needs an explicit read with its scoped instructions. Automatic excerpts only count as inspected evidence if they reach a model request.

## How selection works

Selection runs entirely on the user's computer:

1. Ripgrep lists eligible files and returns only matched query terms with file paths. It never returns source lines through the navigation map. Per-file term sampling stops after 64 matching lines.
2. Ranking favors explicit paths, matching filenames, task-term coverage, dependency manifests, and README files. Terms appearing in fewer files in the bounded sample carry more weight than generic words. Text candidates are ranked before selecting 128 matches, so common action words do not bury a later file containing several distinctive details. A named path is ranked before the metadata entry cap, so an alphabetic directory listing does not bury it.
3. Small source reads add Python AST symbols and basic declaration/import hints for other common languages. A direct import from a relevant candidate can raise another file's rank. Git's changed-path metadata adds a small preference for current work.
4. The result shows why each path was selected and where scoped project guidance applies. Symbols and import links are heuristics, not a complete semantic analysis.

The selector never imports or executes project code. Git runs with external diff, text conversion, and filesystem monitor execution disabled. There are no embeddings, hosted services, or persistent source indexes. Each request reads current metadata again, so changed files do not depend on a stale cache.

## Bounds and exclusions

Default selection keeps at most 4,000 discovered metadata entries plus 128 text matches. It examines at most 24 small source files, 64 KiB per file and 512 KiB in total, within a three-second selection budget. Each subprocess also has a deadline and a 2 MiB combined output cap. Python symbol traversal stops after 2,500 syntax nodes; each file contributes at most eight symbols and eight import hints. Binary, invalid UTF-8, and very long minified source lines are skipped.

The automatic task map uses a 4,000-character result budget; a tool request defaults to 5,000 characters and 12 files. Tool callers can request 1–24 files and 1,000–12,000 characters. These are character estimates rather than exact model tokens. Native tool definitions, the original task, and project instructions share the model's context budget. Tasks over 16,000 characters are rejected with a split-task message before inference; they are never silently truncated.

Workspace `.gitignore` rules and nested ignore files apply, including to explicitly mentioned paths. Ignore rules from a parent repository do not hide an independently registered workspace. Built-in private-file, generated-directory, binary, and workspace-boundary rules apply as well. Automatic scanning additionally excludes common credential configuration files. Ripgrep does not follow symlinks, and candidates are checked against the registered root before reading.

A limit, timeout, or unavailable tool produces an explicitly partial map. A missing path is not evidence that a file does not exist. For very large repositories, use specific paths or narrower task terms and request another map. If ripgrep is missing, CodeMe reports that navigation is unavailable and leaves explicit file reads available; it does not fall back to an unbounded recursive scan.

## Navigation is not permission to edit

The model must still call `read_file` for the exact existing source it intends to edit. Only matching source excerpts delivered in an actual model request can establish read evidence. A map, symbol name, search hit, automatic root excerpt, or completed tool call by itself cannot grant edit permission. Whole-file replacement requires a complete bounded read; search-and-replace edits require the exact old text to have been delivered. Existing approval, current-file hash, and scoped-instruction checks continue to apply.

The map improves navigation for a local model. It cannot guarantee that the model chooses the right files or understands a dependency correctly. Generated code, language aliases, dynamic imports, and symbols outside the scan bounds may need direct inspection.
