package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

func TestValidateTokenAcceptsSocketTicket(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-socket-ticket-secret-with-enough-length")
	token := testTicket(t, Claims{
		UserID:       "11111111-1111-4111-8111-111111111111",
		OrgID:        "22222222-2222-4222-8222-222222222222",
		TeamID:       42,
		TeamPublicID: "33333333-3333-4333-8333-333333333333",
		ExpiresAt:    time.Now().Add(time.Minute).Unix(),
	}, []byte("test-socket-ticket-secret-with-enough-length"))

	claims, err := ValidateToken(token)

	if err != nil {
		t.Fatalf("ValidateToken() error = %v", err)
	}
	if claims.TeamID != 42 {
		t.Fatalf("TeamID = %d, want 42", claims.TeamID)
	}
	if claims.TeamPublicID != "33333333-3333-4333-8333-333333333333" {
		t.Fatalf("TeamPublicID = %q", claims.TeamPublicID)
	}
}

func TestValidateTokenRejectsExpiredOrTamperedTicket(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-socket-ticket-secret-with-enough-length")
	expired := testTicket(t, Claims{
		UserID:       "11111111-1111-4111-8111-111111111111",
		OrgID:        "22222222-2222-4222-8222-222222222222",
		TeamID:       42,
		TeamPublicID: "33333333-3333-4333-8333-333333333333",
		ExpiresAt:    time.Now().Add(-time.Minute).Unix(),
	}, []byte("test-socket-ticket-secret-with-enough-length"))
	valid := testTicket(t, Claims{
		UserID:       "11111111-1111-4111-8111-111111111111",
		OrgID:        "22222222-2222-4222-8222-222222222222",
		TeamID:       42,
		TeamPublicID: "33333333-3333-4333-8333-333333333333",
		ExpiresAt:    time.Now().Add(time.Minute).Unix(),
	}, []byte("wrong-socket-ticket-secret-with-enough-length"))

	_, expiredErr := ValidateToken(expired)
	_, tamperedErr := ValidateToken(valid)

	if expiredErr == nil {
		t.Fatal("expired ticket was accepted")
	}
	if tamperedErr == nil {
		t.Fatal("tampered ticket was accepted")
	}
}

func testTicket(t *testing.T, claims Claims, secret []byte) string {
	t.Helper()
	header := encodePart(t, ticketHeader{Algorithm: "HS256", Type: "JWT"})
	payload := encodePart(t, claims)
	unsigned := header + "." + payload
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(unsigned))
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func encodePart(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal ticket part: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(data)
}
