// Independent MRL-0010 DLEQ verifier, written from the construction
// (PAPER.md) and the go-dleq reference source. Verify-only: it reads the
// shared ninsei-dleq-vector/2 JSON schema and checks proofs the way the SDK
// verifier does (SDK mode: bits=253, context prefix, LE challenge reduction
// on both curves, strict ed25519 subgroup checks, knowledge proofs).
//
//   dleq-verify check <vectors-dir>     every vector meets its expectation
//   dleq-verify verify --file X [--context C]
use curve25519_dalek::constants::ED25519_BASEPOINT_POINT;
use curve25519_dalek::edwards::{CompressedEdwardsY, EdwardsPoint};
use curve25519_dalek::scalar::Scalar as EdScalar;
use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::{ProjectivePoint, Scalar as SecpScalar, PublicKey};
use serde::Deserialize;
use sha3::{Digest, Sha3_512};
use std::fs;
use std::path::Path;

const BITS: usize = 253;

const SECP_ALT_HEX: &str = "0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
const ED_ALT_HEX: &str = "8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94";

#[derive(Deserialize)]
struct Vector {
    context: String,
    proof: VProof,
}

#[derive(Deserialize)]
struct VProof {
    #[serde(rename = "XA")]
    xa: String,
    #[serde(rename = "XB")]
    xb: String,
    #[serde(rename = "pokA")]
    pok_a: Option<VPok>,
    #[serde(rename = "pokB")]
    pok_b: Option<VPok>,
    proofs: Vec<VPart>,
}

#[derive(Deserialize)]
struct VPok {
    #[serde(rename = "R")]
    r: String,
    s: String,
}

#[derive(Deserialize)]
struct VPart {
    #[serde(rename = "cA")]
    ca: String,
    #[serde(rename = "cB")]
    cb: String,
    sig: VSig,
}

#[derive(Deserialize)]
struct VSig {
    #[serde(rename = "eA")]
    ea: String,
    #[serde(rename = "eB")]
    eb: String,
    a0: String,
    a1: String,
    b0: String,
    b1: String,
}

fn hexb(s: &str) -> Result<Vec<u8>, String> {
    hex::decode(s.strip_prefix("0x").unwrap_or(s)).map_err(|e| e.to_string())
}

fn secp_from_hex(s: &str) -> Result<ProjectivePoint, String> {
    let b = hexb(s)?;
    PublicKey::from_sec1_bytes(&b)
        .map(|k| ProjectivePoint::from(k))
        .map_err(|e| e.to_string())
}

fn ed_from_hex(s: &str) -> Result<EdwardsPoint, String> {
    let b = hexb(s)?;
    if b.len() != 32 {
        return Err("ed25519 point must be 32 bytes".into());
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&b);
    CompressedEdwardsY(arr)
        .decompress()
        .ok_or_else(|| "ed25519 decompress failed".into())
}

// SDK scalar rule: big-endian display integer reduced mod the group order.
fn secp_scalar(s: &str) -> Result<SecpScalar, String> {
    let b = hexb(s)?;
    if b.len() > 32 {
        return Err("scalar too long".into());
    }
    let mut arr = [0u8; 32];
    arr[32 - b.len()..].copy_from_slice(&b);
    Ok(SecpScalar::reduce(k256::U256::from_be_slice(&arr)))
}

fn ed_scalar(s: &str) -> Result<EdScalar, String> {
    let b = hexb(s)?;
    if b.len() > 32 {
        return Err("scalar too long".into());
    }
    let mut arr = [0u8; 32];
    arr[32 - b.len()..].copy_from_slice(&b);
    // SDK reduces the integer mod l (mPublic); dalek's from_bytes_mod_order
    // does exactly that for a 32-byte little-endian input, so re-encode BE->LE.
    arr.reverse();
    Ok(EdScalar::from_bytes_mod_order(arr))
}

fn sha3_512(parts: &[&[u8]]) -> [u8; 64] {
    let mut h = Sha3_512::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

// Challenge, SDK mode: SHA3-512 read least-significant-first, reduced mod the
// curve order. For ed25519 dalek's wide reduction is already LE; for
// secp256k1 the digest is reversed to big-endian and reduced.
fn challenge_secp(parts: &[&[u8]]) -> SecpScalar {
    let d = sha3_512(parts);
    // The SDK reads the 64-byte SHA3 digest as a big integer with the LAST byte most significant (bytesToBigLE:
    // v = (v << 8) | d[i] for i from 63 down to 0), then reduces modulo the curve order. A 64-byte U256 conversion
    // cannot represent that: reduce with scalar arithmetic instead of truncating the digest.
    let mut acc = SecpScalar::ZERO;
    for byte in d.iter().rev() {
        acc = acc * SecpScalar::from(256u64) + SecpScalar::from(u64::from(*byte));
    }
    acc
}
fn challenge_ed(parts: &[&[u8]]) -> EdScalar {
    let d = sha3_512(parts);
    EdScalar::from_bytes_mod_order_wide(&d)
}

fn sum_commitments_secp(cs: &[ProjectivePoint]) -> ProjectivePoint {
    let mut acc = cs[0];
    let mut w = SecpScalar::ONE + SecpScalar::ONE;
    for c in &cs[1..] {
        acc += *c * w;
        w = w + w;
    }
    acc
}
fn sum_commitments_ed(cs: &[EdwardsPoint]) -> EdwardsPoint {
    let mut acc = cs[0];
    let mut w = EdScalar::ONE + EdScalar::ONE;
    for c in &cs[1..] {
        acc += c * w;
        w = w + w;
    }
    acc
}

fn verify_pok_secp(x: ProjectivePoint, pok: &VPok, ctxb: &[u8]) -> Result<(), String> {
    let r = secp_from_hex(&pok.r).map_err(|e| "pokA R: ".to_string() + &e)?;
    let s = secp_scalar(&pok.s).map_err(|e| "pokA s: ".to_string() + &e)?;
    let xb = x.to_encoded_point(true);
    let rb = r.to_encoded_point(true);
    let e = challenge_secp(&[ctxb, b"ninsei-dleq-pok|A", xb.as_bytes(), rb.as_bytes()]);
    eprintln!("RUST pokA e={:x?} s={:x?}", e.to_bytes(), s.to_bytes());
    if ProjectivePoint::GENERATOR * s != r + x * e {
        return Err("pokA did not verify".into());
    }
    Ok(())
}

fn verify_pok_ed(x: EdwardsPoint, pok: &VPok, ctxb: &[u8]) -> Result<(), String> {
    let r = ed_from_hex(&pok.r).map_err(|e| "pokB R: ".to_string() + &e)?;
    let s = ed_scalar(&pok.s).map_err(|e| "pokB s: ".to_string() + &e)?;
    let xb = x.compress().to_bytes();
    let rb = r.compress().to_bytes();
    let e = challenge_ed(&[ctxb, b"ninsei-dleq-pok|B", &xb, &rb]);
    if ED25519_BASEPOINT_POINT * s != r + x * e {
        return Err("pokB did not verify".into());
    }
    Ok(())
}

fn verify(v: &Vector, override_context: Option<&str>) -> Result<(), String> {
    let ctx = override_context.unwrap_or(&v.context);
    let ctxb = ctx.as_bytes();

    let xa = secp_from_hex(&v.proof.xa).map_err(|e| "XA: ".to_string() + &e)?;
    let xb = ed_from_hex(&v.proof.xb).map_err(|e| "XB: ".to_string() + &e)?;
    if !xb.is_torsion_free() {
        return Err("XB is not in the prime-order subgroup".into());
    }
    // THE PURE-MULTIPLE GUARD. A v2 proof without both knowledge proofs is refused before the bit loop.
    let pok_a = v.proof.pok_a.as_ref().ok_or("proof: missing pokA")?;
    let pok_b = v.proof.pok_b.as_ref().ok_or("proof: missing pokB")?;
    verify_pok_secp(xa, pok_a, ctxb)?;
    verify_pok_ed(xb, pok_b, ctxb)?;
    if v.proof.proofs.len() != BITS {
        return Err(format!(
            "proof: {} parts, expected {}",
            v.proof.proofs.len(),
            BITS
        ));
    }

    let mut cas = Vec::with_capacity(BITS);
    let mut cbs = Vec::with_capacity(BITS);
    for (i, p) in v.proof.proofs.iter().enumerate() {
        cas.push(secp_from_hex(&p.ca).map_err(|e| format!("bit {} cA: {}", i, e))?);
        cbs.push(ed_from_hex(&p.cb).map_err(|e| format!("bit {} cB: {}", i, e))?);
    }

    if sum_commitments_secp(&cas) != xa {
        return Err("the commitment sum does not give X on secp256k1".into());
    }
    if sum_commitments_ed(&cbs) != xb {
        return Err("the commitment sum does not give X on ed25519".into());
    }

    let secp_alt = secp_from_hex(SECP_ALT_HEX).unwrap();
    let ed_alt = ed_from_hex(ED_ALT_HEX).unwrap();

    for (i, p) in v.proof.proofs.iter().enumerate() {
        if !cbs[i].is_torsion_free() {
            return Err(format!("bit {}: commitment not in the prime-order subgroup", i));
        }
        let ea = secp_scalar(&p.sig.ea).map_err(|e| format!("bit {}: {}", i, e))?;
        let eb = ed_scalar(&p.sig.eb).map_err(|e| format!("bit {}: {}", i, e))?;
        let a0 = secp_scalar(&p.sig.a0).map_err(|e| format!("bit {}: {}", i, e))?;
        let a1 = secp_scalar(&p.sig.a1).map_err(|e| format!("bit {}: {}", i, e))?;
        let b0 = ed_scalar(&p.sig.b0).map_err(|e| format!("bit {}: {}", i, e))?;
        let b1 = ed_scalar(&p.sig.b1).map_err(|e| format!("bit {}: {}", i, e))?;

        let ca = cas[i];
        let cb = cbs[i];

        // branch 1 (bit = 1)
        let ag = secp_alt * a1;
        let eca = ca * ea;
        let bh = ed_alt * b1;
        let ecb = cb * eb;
        let t1 = ag - eca;
        let t2 = bh - ecb;
        let cac = ca.to_encoded_point(true);
        let cbc = cb.compress().to_bytes();
        let t1c = t1.to_encoded_point(true);
        let t2c = t2.compress().to_bytes();
        let ea1 = challenge_secp(&[ctxb, cac.as_bytes(), &cbc, t1c.as_bytes(), &t2c]);
        let eb1 = challenge_ed(&[ctxb, cac.as_bytes(), &cbc, t1c.as_bytes(), &t2c]);

        // branch 0 (bit = 0)
        let ag0 = secp_alt * a0;
        let eca0 = (ca - ProjectivePoint::GENERATOR) * ea1;
        let bh0 = ed_alt * b0;
        let ecb0 = (cb - ED25519_BASEPOINT_POINT) * eb1;
        let t10 = ag0 - eca0;
        let t20 = bh0 - ecb0;
        let t10c = t10.to_encoded_point(true);
        let t20c = t20.compress().to_bytes();
        let ea0 = challenge_secp(&[ctxb, cac.as_bytes(), &cbc, t10c.as_bytes(), &t20c]);
        let eb0 = challenge_ed(&[ctxb, cac.as_bytes(), &cbc, t10c.as_bytes(), &t20c]);

        if ea0 != ea || eb0 != eb {
            return Err(format!("bit {}: challenges did not match", i));
        }
    }
    Ok(())
}

fn check_dir(dir: &str) -> i32 {
    let mut pass = 0i32;
    let mut failed = 0i32;
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| e.to_string())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
        .collect();
    entries.sort();
    for path in entries {
        let text = fs::read_to_string(&path).unwrap();
        let raw: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                println!("  FAIL  {}: unreadable JSON: {}", path.display(), e);
                failed += 1;
                continue;
            }
        };
        let expect = raw.get("expect").and_then(|e| e.get("verify")).and_then(|v| v.as_bool()).unwrap_or(true);
        // THE NEGATIVE CORPUS IS MALFORMED ON PURPOSE. A strict deserialization failure is a refusal, not a reason
        // to abort the whole run; compare it with the vector's expectation.
        let got = match serde_json::from_value::<Vector>(raw) {
            Ok(v) => verify(&v, None).is_ok(),
            Err(_) => false,
        };
        if got == expect {
            pass += 1;
            println!("  ok    {}", path.display());
        } else {
            failed += 1;
            println!("  FAIL  {}: expected verify={}, got {}", path.display(), expect, got);
        }
    }
    println!("rust-check: {} passed, {} failed", pass, failed);
    if failed > 0 {
        1
    } else {
        0
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 3 && args[1] == "check" {
        std::process::exit(check_dir(&args[2]));
    }
    if args.len() >= 3 && args[1] == "verify" {
        let mut file: Option<String> = None;
        let mut ctx: Option<String> = None;
        let mut i = 2;
        while i < args.len() {
            if args[i] == "--file" {
                file = Some(args[i + 1].clone());
                i += 2;
            } else if args[i] == "--context" {
                ctx = Some(args[i + 1].clone());
                i += 2;
            } else {
                i += 1;
            }
        }
        let text = fs::read_to_string(file.unwrap()).unwrap();
        let v: Vector = serde_json::from_str(&text).unwrap();
        match verify(&v, ctx.as_deref()) {
            Ok(()) => println!("{{\"ok\":true}}"),
            Err(r) => {
                println!("{{\"ok\":false,\"reason\":{:?}}}", r);
                std::process::exit(1);
            }
        }
        return;
    }
    eprintln!("usage: dleq-verify check <dir> | verify --file X [--context C]");
    std::process::exit(2);
}

// keep Path import used for older toolchains
#[allow(dead_code)]
fn _p(_: &Path) {}
