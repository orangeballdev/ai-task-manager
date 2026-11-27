import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Returns only metadata — never the certificate bytes or passphrase.
export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const provider = await prisma.aIProvider.findUnique({ where: { id } });
  if (!provider || provider.type !== "claude-pki") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    exists: !!provider.pkiCertData,
    filename: provider.pkiCertFilename,
    passphraseSet: !!provider.pkiCertPassphrase,
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const provider = await prisma.aIProvider.findUnique({ where: { id } });
  if (!provider || provider.type !== "claude-pki") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json() as { certBase64?: string; filename?: string; passphrase?: string | null };
  const { certBase64, filename, passphrase } = body;

  if (!certBase64?.trim()) {
    return NextResponse.json({ ok: false, error: "No certificate provided" }, { status: 400 });
  }

  let certBuffer: Buffer;
  try {
    certBuffer = Buffer.from(certBase64, "base64");
    if (certBuffer.length === 0) throw new Error("empty");
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid certificate data" }, { status: 400 });
  }

  await prisma.aIProvider.update({
    where: { id },
    data: {
      pkiCertData: certBuffer,
      pkiCertFilename: filename?.trim() || null,
      // Only touch the passphrase when explicitly provided in the payload, so
      // re-uploading just the cert doesn't require re-entering it.
      ...("passphrase" in body && { pkiCertPassphrase: passphrase?.trim() || null }),
    },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const provider = await prisma.aIProvider.findUnique({ where: { id } });
  if (!provider || provider.type !== "claude-pki") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.aIProvider.update({
    where: { id },
    data: { pkiCertData: null, pkiCertFilename: null, pkiCertPassphrase: null },
  });

  return NextResponse.json({ ok: true });
}
