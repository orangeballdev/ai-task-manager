-- Adds mutual-TLS (PKI) auth support for self-hosted Claude-compatible providers
ALTER TABLE "AIProvider" ADD COLUMN "pkiCertData" BLOB;
ALTER TABLE "AIProvider" ADD COLUMN "pkiCertFilename" TEXT;
ALTER TABLE "AIProvider" ADD COLUMN "pkiCertPassphrase" TEXT;
ALTER TABLE "AIProvider" ADD COLUMN "proxyUrl" TEXT;
