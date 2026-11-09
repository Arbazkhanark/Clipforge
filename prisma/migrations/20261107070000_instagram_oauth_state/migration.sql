-- Stores hashed one-use Instagram OAuth state in the existing AuthToken table.
-- The raw state remains only in the short-lived HttpOnly browser cookie.
ALTER TYPE "AuthTokenKind" ADD VALUE 'instagram_oauth_state';
