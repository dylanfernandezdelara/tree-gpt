CREATE TABLE IF NOT EXISTS "user" (
  "id" text not null primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" integer not null,
  "image" text,
  "createdAt" date not null,
  "updatedAt" date not null
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" text not null primary key,
  "expiresAt" date not null,
  "token" text not null unique,
  "createdAt" date not null,
  "updatedAt" date not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user" ("id") on delete cascade
);

CREATE TABLE IF NOT EXISTS "account" (
  "id" text not null primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" date,
  "refreshTokenExpiresAt" date,
  "scope" text,
  "password" text,
  "createdAt" date not null,
  "updatedAt" date not null
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text not null primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" date not null,
  "createdAt" date not null,
  "updatedAt" date not null
);

CREATE TABLE IF NOT EXISTS "passkey" (
  "id" text not null primary key,
  "name" text,
  "publicKey" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "credentialID" text not null,
  "counter" integer not null,
  "deviceType" text not null,
  "backedUp" integer not null,
  "transports" text,
  "createdAt" date,
  "aaguid" text
);

CREATE INDEX IF NOT EXISTS "session_userId_idx" on "session" ("userId");
CREATE INDEX IF NOT EXISTS "account_userId_idx" on "account" ("userId");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" on "verification" ("identifier");
CREATE INDEX IF NOT EXISTS "passkey_userId_idx" on "passkey" ("userId");
CREATE INDEX IF NOT EXISTS "passkey_credentialID_idx" on "passkey" ("credentialID");
