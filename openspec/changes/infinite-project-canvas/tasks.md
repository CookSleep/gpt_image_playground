## 1. Data Model and Persistence

- [x] 1.1 Add versioned per-project canvas state types for viewport, image layout, z-order, and image-level favorite collection IDs.
- [x] 1.2 Add canvas normalization and deterministic default placement for legacy projects and newly discovered output images.
- [x] 1.3 Persist canvas state through Zustand/IndexedDB project records and trigger existing online project sync when viewport or node state changes.
- [x] 1.4 Extend ZIP export/import and online project archive serialization to include optional canvas state while remaining compatible with older archives.
- [x] 1.5 Add unit tests for canvas state normalization, default placement, stale node cleanup, and persistence migration.

## 2. Canvas Rendering and Interaction

- [x] 2.1 Create a project canvas component that flattens task outputs into stable single-image nodes while retaining parent task metadata.
- [x] 2.2 Render cached thumbnails for completed nodes and independent loading/error nodes for running or partially failed outputs.
- [x] 2.3 Implement world-coordinate transforms with background pan, pointer-centered wheel zoom, touch pinch zoom, and stable viewport bounds/controls.
- [x] 2.4 Implement image node dragging, single selection, empty-canvas deselection, and event isolation from existing drag-select and input controls.
- [x] 2.5 Add viewport-aware node culling or equivalent visibility checks so projects with many images do not mount or decode every node at once.
- [x] 2.6 Render a fixed-screen-size toolbar above the selected node and reposition it when the node is near a viewport edge.
- [x] 2.7 Replace the project page `TaskGrid` surface with the canvas while preserving search/status/favorite filters, legacy controls, Agent panel, Lightbox, and bottom input flow.
- [x] 2.8 Add responsive desktop/mobile styling and reduce the prompt contentEditable's compact default height without breaking multiline auto-growth or attachment controls.

## 3. Single-Image Operations

- [x] 3.1 Add a single-output operation helper that resolves an image ID to its parent task and updates output arrays plus per-image metadata atomically.
- [x] 3.2 Implement current-image Lightbox, download, copy, add-reference, and save-to-material actions in the canvas toolbar.
- [x] 3.3 Adapt reuse-config, edit-output, and retry flows to use the selected image and its parent task context without including sibling outputs.
- [x] 3.4 Add image-level favorite collection state and update favorite filtering, collection counts, and favorite views to operate on individual images.
- [x] 3.5 Implement confirmation and execution for deleting one output from a multi-image task, including transparent-original metadata, parameter maps, output errors, local cleanup, and online cleanup.
- [x] 3.6 Preserve Agent output reference slots or an equivalent stable mapping after deleting an image, and render deleted references explicitly.
- [x] 3.7 Keep parent task history when its last output is deleted and remove its canvas nodes and stale layout entries.
- [x] 3.8 Add unit tests covering sibling isolation, last-output deletion, image-reference retention, favorite isolation, and Agent reference stability.

## 4. Verification

- [x] 4.1 Add component-level interaction coverage for selection, toolbar actions, pan/zoom, node movement, filtering, and mobile pointer gestures.
- [x] 4.2 Run `npm run build` and `npm test`, then manually verify desktop and mobile project workspaces with legacy and online projects.
