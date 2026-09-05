package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"time"
)

type Claims struct {
	UserID       string `json:"user_id"`
	OrgID        string `json:"org_id"`
	TeamID       int64  `json:"team_id"`
	TeamPublicID string `json:"team_public_id"`
	ExpiresAt    int64  `json:"exp"`
}

type ticketHeader struct {
	Algorithm string `json:"alg"`
	Type      string `json:"typ"`
}

func jwtSecret() []byte {
	if secret := strings.TrimSpace(os.Getenv("JWT_SECRET")); secret != "" {
		return []byte(secret)
	}
	return []byte("development-socket-ticket-secret-change-me")
}

func ValidateToken(tokenString string) (*Claims, error) {
	tokenString = strings.TrimSpace(tokenString)
	parts := strings.Split(tokenString, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return nil, errors.New("invalid token")
	}
	if err := validateHeader(parts[0]); err != nil {
		return nil, err
	}
	if !validSignature(parts, jwtSecret()) {
		return nil, errors.New("invalid signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, errors.New("invalid payload")
	}
	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, errors.New("invalid claims")
	}
	if claims.UserID == "" || claims.OrgID == "" || claims.TeamID < 1 || claims.TeamPublicID == "" {
		return nil, errors.New("missing claims")
	}
	if time.Now().Unix() >= claims.ExpiresAt {
		return nil, errors.New("expired token")
	}
	return &claims, nil
}

func validateHeader(encoded string) error {
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return errors.New("invalid header")
	}
	var header ticketHeader
	if err := json.Unmarshal(data, &header); err != nil {
		return errors.New("invalid header")
	}
	if header.Algorithm != "HS256" || header.Type != "JWT" {
		return errors.New("unexpected signing method")
	}
	return nil
}

func validSignature(parts []string, secret []byte) bool {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(want), []byte(parts[2]))
}
