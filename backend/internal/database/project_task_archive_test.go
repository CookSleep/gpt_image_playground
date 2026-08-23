package database

import (
	"archive/zip"
	"bytes"
	"encoding/json"
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
