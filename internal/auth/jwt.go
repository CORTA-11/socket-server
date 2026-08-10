package auth

import (
	"errors"
	"os"

	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	UserID  int64  `json:"user_id"`
	OrgID   int64  `json:"org_id"`
	OrgRole string `json:"org_role"`
	jwt.RegisteredClaims
}

func jwtSecret() []byte {
	if secret := os.Getenv("JWT_SECRET"); secret != "" {
		return []byte(secret)
	}
	return []byte("your-super-secret-key-change-in-production")
}

func ValidateToken(tokenString string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return jwtSecret(), nil
	})
	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}
