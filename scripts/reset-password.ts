// Emergency password reset for a locked-out account. Run on the host (or in the
// app container) with access to the database:
//
//   npx tsx scripts/reset-password.ts you@example.com 'new-password'
//
// Sets the password, turns password sign-in back on, marks it for change on next
// visit and signs the account out everywhere. Creates the account if it doesn't exist.
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { hashPassword, validatePasswordStrength } from "../src/lib/auth/password";
import { normalizeEmail } from "../src/lib/auth/policy";

async function main() {
  const [rawEmail, password] = process.argv.slice(2);
  const email = normalizeEmail(rawEmail);
  if (!email || !password) {
    console.error("Usage: npx tsx scripts/reset-password.ts <email> <new-password>");
    process.exit(1);
  }
  const err = validatePasswordStrength(password);
  if (err) {
    console.error(err);
    process.exit(1);
  }
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, passwordHash, mustChangePassword: true },
    update: { passwordHash, passwordLoginDisabled: false, mustChangePassword: true },
  });
  const { count } = await prisma.session.deleteMany({ where: { userId: user.id } });
  console.log(`Password reset for ${email}; signed out ${count} session(s).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
