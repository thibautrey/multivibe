package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAutomaticSchedulePersistsAndSkipsMissedNights(t *testing.T) {
	zone := time.FixedZone("local", 2*3600)
	now := time.Date(2026, 9, 16, 12, 0, 0, 0, zone)
	update := updater{store: testStore(t), now: func() time.Time { return now }}
	state, _ := defaultState("1.0.0")
	due, err := update.automaticDue(&state)
	if err != nil || due {
		t.Fatalf("first run: %v %v", due, err)
	}
	slot, err := time.Parse(time.RFC3339Nano, state.NextAutomaticAt)
	if err != nil || slot.Day() != 17 || slot.Hour() < 2 || slot.Hour() >= 5 {
		t.Fatalf("bad slot: %s", state.NextAutomaticAt)
	}
	saved := state.NextAutomaticAt
	now = now.Add(time.Hour)
	if due, err = update.automaticDue(&state); err != nil || due || state.NextAutomaticAt != saved {
		t.Fatal("schedule rerolled")
	}
	now = slot
	if due, err = update.automaticDue(&state); err != nil || !due {
		t.Fatal("scheduled night did not run")
	}
	if state.NextAutomaticAt == saved {
		t.Fatal("next night was not persisted")
	}
	now = now.AddDate(0, 0, 2)
	if due, err = update.automaticDue(&state); err != nil || due {
		t.Fatal("missed night ran on wake")
	}
	now = time.Date(2026, 9, 21, 9, 0, 0, 0, zone)
	state.NextAutomaticAt = time.Date(2026, 9, 21, 3, 0, 0, 0, zone).Format(time.RFC3339Nano)
	if due, err = update.automaticDue(&state); err != nil || due {
		t.Fatal("daytime catchup ran")
	}
}

func TestAutomaticDaytimeDoesNotAccessNetwork(t *testing.T) {
	now := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)
	update := updater{store: testStore(t), now: func() time.Time { return now }, httpClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected download"); return nil, nil })}}
	state, _ := defaultState("1.0.0")
	state.NextAutomaticAt = now.Add(-9 * time.Hour).Format(time.RFC3339Nano)
	if err := runAutomatic(context.Background(), &update, &state); err != nil {
		t.Fatal(err)
	}
}

func TestQuietPreflightAndDrainRace(t *testing.T) {
	for _, initial := range []string{`{}`, `{"quiet":false}`, `{"quiet":true}`} {
		t.Run(initial, func(t *testing.T) {
			store := testStore(t)
			drained := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/drain") {
					drained = true
					w.Write([]byte(`{}`))
					return
				}
				if drained {
					w.Write([]byte(`{"quiet":false,"ready":true}`))
				} else {
					w.Write([]byte(initial))
				}
			}))
			defer server.Close()
			t.Setenv("MULTIVIBE_CONTROL_PLANE_PORT", strings.Split(strings.TrimPrefix(server.URL, "http://"), ":")[1])
			credentials := `{"schema_version":"multivibe-host-credentials-v1","admin_token":"` + strings.Repeat("a", 32) + `","proxy_api_key":"` + strings.Repeat("b", 32) + `"}`
			if err := os.WriteFile(filepath.Join(store.directory, "host-credentials.json"), []byte(credentials), 0600); err != nil {
				t.Fatal(err)
			}
			update := updater{store: store, now: time.Now}
			if err := update.drain(context.Background()); err == nil {
				t.Fatal("unsafe restart allowed")
			}
			if drained != (initial == `{"quiet":true}`) {
				t.Fatal("busy or unknown Host was drained")
			}
		})
	}
}

func TestExplicitDownloadDoesNotAuthorizeDaytimeInstallation(t *testing.T) {
	now := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)
	update := updater{store: testStore(t), now: func() time.Time { return now }}
	state, _ := defaultState("1.0.0")
	state.Status = "downloaded"
	state.DownloadRequested = true
	state.DownloadedPath = "cached-archive"
	state.NextCheckAt = now.Add(time.Hour).Format(time.RFC3339Nano)
	if err := runAutomatic(context.Background(), &update, &state); err != nil {
		t.Fatal(err)
	}
	if state.Status != "downloaded" || state.DownloadRequested {
		t.Fatal("download-only action attempted installation or stayed queued")
	}
}
