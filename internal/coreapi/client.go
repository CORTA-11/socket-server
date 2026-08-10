package coreapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	baseURL     string
	internalKey string
	httpClient  *http.Client
}

type TeamAccess struct {
	TeamID   int64  `json:"team_id"`
	PublicID string `json:"public_id"`
	OrgID    int64  `json:"org_id"`
	Role     string `json:"role"`
}

func NewFromEnv() *Client {
	baseURL := os.Getenv("CORE_API_URL")
	if baseURL == "" {
		baseURL = "http://localhost:8080"
	}
	key := os.Getenv("INTERNAL_API_KEY")
	if key == "" {
		key = "dev-internal-key-change-me"
	}
	return &Client{
		baseURL:     strings.TrimRight(baseURL, "/"),
		internalKey: key,
		httpClient: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

func (c *Client) CheckTeamAccess(ctx context.Context, teamPublicID string, userID int64) (*TeamAccess, error) {
	q := url.Values{}
	q.Set("team_public_id", teamPublicID)
	q.Set("user_id", strconv.FormatInt(userID, 10))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/internal/team-access?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Internal-Key", c.internalKey)

	res, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	if res.StatusCode == http.StatusForbidden {
		return nil, fmt.Errorf("forbidden")
	}
	if res.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("not found")
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("core-api status %d", res.StatusCode)
	}

	var access TeamAccess
	if err := json.NewDecoder(res.Body).Decode(&access); err != nil {
		return nil, err
	}
	return &access, nil
}
