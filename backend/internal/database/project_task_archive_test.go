package database

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"testing"
)

func projectArchiveForTest(t *testing.T, manifest string) []byte {
	t.Helper()
	var result bytes.Buffer
	writer := zip.NewWriter(&result)
	file, err := writer.Create("manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte(manifest)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return result.Bytes()
}

func projectManifestForTest(t *testing.T, archive []byte) map[string]json.RawMessage {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range reader.File {
		if file.Name != "manifest.json" {
			continue
		}
		content, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		defer content.Close()
		data, err := io.ReadAll(content)
		if err != nil {
			t.Fatal(err)
		}
		var manifest map[string]json.RawMessage
		if err := json.Unmarshal(data, &manifest); err != nil {
			t.Fatal(err)
		}
		return manifest
	}
	t.Fatal("manifest not found")
	return nil
}

func TestRewriteProjectTaskArchiveUpsertsTaskAndPreservesOtherRecords(t *testing.T) {
	archive := projectArchiveForTest(t, `{
		"version": 4,
		"tasks": [{"id":"task-old","status":"running"},{"id":"task-b","status":"done"}],
		"favoriteCollections": [{"id":"favorite-a"}],
		"agentConversations": [{"id":"conversation-a"}]
	}`)
	updated, err := rewriteProjectTaskArchive(
		archive,
		json.RawMessage(`{"id":"project-a","title":"项目 A"}`),
		json.RawMessage(`{"id":"task-old","status":"done"}`),
		"task-old",
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	manifest := projectManifestForTest(t, updated)
	var tasks []json.RawMessage
	if err := json.Unmarshal(manifest["tasks"], &tasks); err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 2 || projectArchiveRecordID(tasks[0]) != "task-old" || projectArchiveRecordID(tasks[1]) != "task-b" {
		t.Fatalf("unexpected tasks: %s", manifest["tasks"])
	}
	if !bytes.Contains(manifest["favoriteCollections"], []byte("favorite-a")) || !bytes.Contains(manifest["agentConversations"], []byte("conversation-a")) {
		t.Fatal("unrelated project records were lost")
	}
}

func TestRewriteProjectTaskArchiveDeletesOnlySelectedTask(t *testing.T) {
	archive := projectArchiveForTest(t, `{"version":4,"tasks":[{"id":"task-a"},{"id":"task-b"}]}`)
	updated, err := rewriteProjectTaskArchive(archive, nil, nil, "task-a", true)
	if err != nil {
		t.Fatal(err)
	}
	manifest := projectManifestForTest(t, updated)
	var tasks []json.RawMessage
	if err := json.Unmarshal(manifest["tasks"], &tasks); err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || projectArchiveRecordID(tasks[0]) != "task-b" {
		t.Fatalf("unexpected tasks: %s", manifest["tasks"])
	}
}

func TestRewriteProjectCanvasArchiveUpdatesOnlyCanvas(t *testing.T) {
	archive := projectArchiveForTest(t, `{"version":4,"projects":[{"id":"project-a","title":"A","canvas":{"version":1,"viewport":{"x":0}}}],"tasks":[{"id":"task-a"}]}`)
	updated, err := rewriteProjectCanvasArchive(archive, "project-a", json.RawMessage(`{"version":1,"viewport":{"x":12,"y":8,"scale":1.2},"items":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	manifest := projectManifestForTest(t, updated)
	var projects []map[string]json.RawMessage
	if err := json.Unmarshal(manifest["projects"], &projects); err != nil {
		t.Fatal(err)
	}
	var canvas map[string]any
	if len(projects) != 1 || json.Unmarshal(projects[0]["canvas"], &canvas) != nil || canvas["version"] != float64(1) || canvas["viewport"].(map[string]any)["x"] != float64(12) {
		t.Fatalf("unexpected project canvas: %s", manifest["projects"])
	}
	var tasks []map[string]any
	if err := json.Unmarshal(manifest["tasks"], &tasks); err != nil || len(tasks) != 1 || tasks[0]["id"] != "task-a" {
		t.Fatalf("unrelated tasks changed: %s", manifest["tasks"])
	}
}

func TestReadProjectCanvasArchive(t *testing.T) {
	archive := projectArchiveForTest(t, `{"version":4,"projects":[{"id":"project-a","canvas":{"version":1,"viewport":{"x":12,"y":8,"scale":1},"items":{}}}]}`)
	canvas, err := readProjectCanvasArchive(archive, "project-a")
	if err != nil {
		t.Fatal(err)
	}
	if string(canvas) != `{"version":1,"viewport":{"x":12,"y":8,"scale":1},"items":{}}` {
		t.Fatalf("unexpected canvas: %s", canvas)
	}

	legacyArchive := projectArchiveForTest(t, `{"version":4,"projects":[{"id":"project-a"}]}`)
	if _, err := readProjectCanvasArchive(legacyArchive, "project-a"); !errors.Is(err, ErrProjectCanvasNotFound) {
		t.Fatalf("want missing canvas error, got %v", err)
	}
}

func TestRewriteProjectCanvasViewportArchive(t *testing.T) {
	archive := projectArchiveForTest(t, `{"version":4,"projects":[{"id":"project-a","title":"A","canvas":{"version":1,"viewport":{"x":0,"y":0,"scale":1},"items":{"image-a":{"x":1,"y":2,"width":240}}}}],"tasks":[]}`)
	updated, err := rewriteProjectCanvasViewportArchive(archive, "project-a", json.RawMessage(`{"x":12,"y":8,"scale":1.5}`))
	if err != nil {
		t.Fatal(err)
	}
	canvas, err := readProjectCanvasArchive(updated, "project-a")
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	if err := json.Unmarshal(canvas, &record); err != nil {
		t.Fatal(err)
	}
	viewport := record["viewport"].(map[string]any)
	if viewport["x"] != float64(12) || viewport["y"] != float64(8) || viewport["scale"] != float64(1.5) {
		t.Fatalf("unexpected viewport: %s", canvas)
	}
	if _, ok := record["items"].(map[string]any)["image-a"]; !ok {
		t.Fatalf("viewport update dropped canvas items: %s", canvas)
	}
}
