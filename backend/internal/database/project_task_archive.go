package database

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
)

const maxProjectManifestBytes = 32 << 20

func projectArchiveRecordID(raw json.RawMessage) string {
	var record struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &record) != nil {
		return ""
	}
	return record.ID
}

func rewriteProjectTaskArchive(archive []byte, project, task json.RawMessage, taskID string, remove bool) ([]byte, error) {
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return nil, fmt.Errorf("open project archive: %w", err)
	}

	manifest := map[string]json.RawMessage{}
	for _, file := range reader.File {
		if file.Name != "manifest.json" {
			continue
		}
		if file.UncompressedSize64 > maxProjectManifestBytes {
			return nil, errors.New("project manifest is too large")
		}
		content, err := file.Open()
		if err != nil {
			return nil, fmt.Errorf("open project manifest: %w", err)
		}
		data, readErr := io.ReadAll(io.LimitReader(content, maxProjectManifestBytes+1))
		closeErr := content.Close()
		if readErr != nil {
			return nil, fmt.Errorf("read project manifest: %w", readErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("close project manifest: %w", closeErr)
		}
		if len(data) > maxProjectManifestBytes {
			return nil, errors.New("project manifest is too large")
		}
		if err := json.Unmarshal(data, &manifest); err != nil {
			return nil, fmt.Errorf("decode project manifest: %w", err)
		}
		break
	}

	if len(project) > 0 {
		projects, err := json.Marshal([]json.RawMessage{project})
		if err != nil {
			return nil, fmt.Errorf("encode project record: %w", err)
		}
		manifest["projects"] = projects
	}
	var existingTasks []json.RawMessage
	if raw := manifest["tasks"]; len(raw) > 0 && json.Unmarshal(raw, &existingTasks) != nil {
		return nil, errors.New("decode project tasks")
	}
	tasks := make([]json.RawMessage, 0, len(existingTasks)+1)
	if !remove {
		tasks = append(tasks, task)
	}
	for _, existing := range existingTasks {
		if projectArchiveRecordID(existing) == taskID {
			continue
		}
		tasks = append(tasks, existing)
	}
	manifest["tasks"], err = json.Marshal(tasks)
	if err != nil {
		return nil, fmt.Errorf("encode project tasks: %w", err)
	}
	manifest["version"] = json.RawMessage("4")
	manifest["exportedAt"], err = json.Marshal(time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, fmt.Errorf("encode project export time: %w", err)
	}
	manifestJSON, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode project manifest: %w", err)
	}

	var result bytes.Buffer
	writer := zip.NewWriter(&result)
	for _, file := range reader.File {
		if file.Name == "manifest.json" {
			continue
		}
		source, err := file.Open()
		if err != nil {
			_ = writer.Close()
			return nil, fmt.Errorf("open project archive entry: %w", err)
		}
		header := file.FileHeader
		header.Flags = 0
		target, err := writer.CreateHeader(&header)
		if err == nil {
			_, err = io.Copy(target, source)
		}
		closeErr := source.Close()
		if err != nil {
			_ = writer.Close()
			return nil, fmt.Errorf("copy project archive entry: %w", err)
		}
		if closeErr != nil {
			_ = writer.Close()
			return nil, fmt.Errorf("close project archive entry: %w", closeErr)
		}
	}
	manifestHeader := &zip.FileHeader{Name: "manifest.json", Method: zip.Deflate}
	manifestHeader.SetModTime(time.Now().UTC())
	manifestFile, err := writer.CreateHeader(manifestHeader)
	if err == nil {
		_, err = manifestFile.Write(manifestJSON)
	}
	if err != nil {
		_ = writer.Close()
		return nil, fmt.Errorf("write project manifest: %w", err)
	}
	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("close project archive: %w", err)
	}
	return result.Bytes(), nil
}

func rewriteProjectCanvasArchive(archive []byte, projectID string, canvas json.RawMessage) ([]byte, error) {
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return nil, fmt.Errorf("open project archive: %w", err)
	}

	manifest := map[string]json.RawMessage{}
	for _, file := range reader.File {
		if file.Name != "manifest.json" {
			continue
		}
		if file.UncompressedSize64 > maxProjectManifestBytes {
			return nil, errors.New("project manifest is too large")
		}
		content, err := file.Open()
		if err != nil {
			return nil, fmt.Errorf("open project manifest: %w", err)
		}
		data, readErr := io.ReadAll(io.LimitReader(content, maxProjectManifestBytes+1))
		closeErr := content.Close()
		if readErr != nil {
			return nil, fmt.Errorf("read project manifest: %w", readErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("close project manifest: %w", closeErr)
		}
		if len(data) > maxProjectManifestBytes {
			return nil, errors.New("project manifest is too large")
		}
		if err := json.Unmarshal(data, &manifest); err != nil {
			return nil, fmt.Errorf("decode project manifest: %w", err)
		}
		break
	}

	var projects []json.RawMessage
	if raw := manifest["projects"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &projects); err != nil {
			return nil, errors.New("decode project records")
		}
	}
	found := false
	for index, raw := range projects {
		if projectArchiveRecordID(raw) != projectID {
			continue
		}
		var projectRecord map[string]json.RawMessage
		if err := json.Unmarshal(raw, &projectRecord); err != nil {
			return nil, fmt.Errorf("decode project record: %w", err)
		}
		projectRecord["canvas"] = canvas
		projects[index], err = json.Marshal(projectRecord)
		if err != nil {
			return nil, fmt.Errorf("encode project record: %w", err)
		}
		found = true
		break
	}
	if !found {
		return nil, errors.New("project record not found")
	}
	manifest["projects"], err = json.Marshal(projects)
	if err != nil {
		return nil, fmt.Errorf("encode project records: %w", err)
	}
	manifest["version"] = json.RawMessage("4")
	manifest["exportedAt"], err = json.Marshal(time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, fmt.Errorf("encode project export time: %w", err)
	}
	manifestJSON, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode project manifest: %w", err)
	}

	var result bytes.Buffer
	writer := zip.NewWriter(&result)
	for _, file := range reader.File {
		if file.Name == "manifest.json" {
			continue
		}
		source, err := file.Open()
		if err != nil {
			_ = writer.Close()
			return nil, fmt.Errorf("open project archive entry: %w", err)
		}
		header := file.FileHeader
		header.Flags = 0
		target, err := writer.CreateHeader(&header)
		if err == nil {
			_, err = io.Copy(target, source)
		}
		closeErr := source.Close()
		if err != nil {
			_ = writer.Close()
			return nil, fmt.Errorf("copy project archive entry: %w", err)
		}
		if closeErr != nil {
			_ = writer.Close()
			return nil, fmt.Errorf("close project archive entry: %w", closeErr)
		}
	}
	manifestHeader := &zip.FileHeader{Name: "manifest.json", Method: zip.Deflate}
	manifestHeader.SetModTime(time.Now().UTC())
	manifestFile, err := writer.CreateHeader(manifestHeader)
	if err == nil {
		_, err = manifestFile.Write(manifestJSON)
	}
	if err != nil {
		_ = writer.Close()
		return nil, fmt.Errorf("write project manifest: %w", err)
	}
	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("close project archive: %w", err)
	}
	return result.Bytes(), nil
}
