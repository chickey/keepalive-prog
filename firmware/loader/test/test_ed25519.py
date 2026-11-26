"""Checks loader/ed25519.c against Python's cryptography package (host build)."""
import os, random, subprocess, sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization as s

here = os.path.dirname(os.path.abspath(__file__))
exe = os.path.join(here, "verify_cli")
subprocess.check_call(["cc", "-O2", "-Wall", "-Wextra", "-o", exe, os.path.join(here, "verify_cli.c"),
                       os.path.join(here, "..", "ed25519.c"), os.path.join(here, "..", "sha512.c")])
L = 2**252 + 27742317777372353535851937790883648493
rng = random.Random(7)
cases = []  # (pk, sig, msg, expected)

# RFC 8032 test 1 (empty message) and test 2.
cases.append((bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"),
              bytes.fromhex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
              b"", 1))
cases.append((bytes.fromhex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"),
              bytes.fromhex("92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
              bytes.fromhex("72"), 1))

for i in range(120):
    k = Ed25519PrivateKey.generate()
    pk = k.public_key().public_bytes(s.Encoding.Raw, s.PublicFormat.Raw)
    n = rng.choice([0, 1, 63, 64, 111, 112, 127, 128, 129, 255, 1000, 47000])
    m = os.urandom(n)
    sig = k.sign(m)
    cases.append((pk, sig, m, 1))
    kind = i % 5
    if kind == 0 and n:
        b = bytearray(m); b[rng.randrange(n)] ^= 1 << rng.randrange(8); cases.append((pk, sig, bytes(b), 0))
    elif kind == 1:
        b = bytearray(sig); b[rng.randrange(64)] ^= 1 << rng.randrange(8); cases.append((pk, bytes(b), m, 0))
    elif kind == 2:
        other = Ed25519PrivateKey.generate().public_key().public_bytes(s.Encoding.Raw, s.PublicFormat.Raw)
        cases.append((other, sig, m, 0))
    elif kind == 3:
        # Malleated signature: S + L still passes a lax verifier; must be rejected.
        S = int.from_bytes(sig[32:], "little") + L
        if S < 2**256:
            cases.append((pk, sig[:32] + S.to_bytes(32, "little"), m, 0))
    else:
        b = bytearray(pk); b[rng.randrange(32)] ^= 1 << rng.randrange(8); cases.append((bytes(b), sig, m, 0))

inp = "".join(f"{p.hex()} {g.hex()} {m.hex() or '00'[:0]}\n" for p, g, m, _ in cases)
out = subprocess.run([exe], input=inp, capture_output=True, text=True, check=True).stdout.split()
bad = [i for i, (c, o) in enumerate(zip(cases, out)) if str(c[3]) != o]
print(f"{len(cases)} cases, {len(bad)} wrong")
sys.exit(1 if bad or len(out) != len(cases) else 0)
