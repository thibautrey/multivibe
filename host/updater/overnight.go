package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"time"
)

func overnightWindow(now time.Time) bool { return now.Hour() >= 2 && now.Hour() < 6 }

// Leave an hour for scheduler latency and downloads. Persist the random slot
// so frequent scheduler wakeups and process restarts cannot reroll it.
func nextAutomatic(now time.Time) (string, error) {
	start := time.Date(now.Year(), now.Month(), now.Day(), 2, 0, 0, 0, now.Location())
	if !now.Before(start) {
		start = start.AddDate(0, 0, 1)
	}
	offset, err := rand.Int(rand.Reader, big.NewInt(int64(3*time.Hour/time.Second)))
	if err != nil {
		return "", err
	}
	return start.Add(time.Duration(offset.Int64()) * time.Second).Format(time.RFC3339Nano), nil
}

func (update *updater) automaticDue(state *updaterState) (bool, error) {
	now := update.now()
	scheduled, err := time.Parse(time.RFC3339Nano, state.NextAutomaticAt)
	if err == nil && now.Before(scheduled) {
		return false, nil
	}
	due := err == nil && overnightWindow(now) && scheduled.In(now.Location()).Format("2006-01-02") == now.Format("2006-01-02")
	state.NextAutomaticAt, err = nextAutomatic(now)
	if err != nil {
		return false, err
	}
	if err = update.store.save(*state); err != nil {
		return false, err
	}
	return due, nil
}

func (update *updater) requireQuiet(ctx context.Context) error {
	response, err := update.hostRequest(ctx, http.MethodGet, "/admin/host-update/readiness")
	if err != nil {
		return errors.New("update deferred: Host activity could not be verified")
	}
	defer response.Body.Close()
	var status struct {
		Quiet *bool `json:"quiet"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&status) != nil || status.Quiet == nil || !*status.Quiet {
		return errors.New("update deferred: Host needs 30 minutes without active or recent requests")
	}
	return nil
}
