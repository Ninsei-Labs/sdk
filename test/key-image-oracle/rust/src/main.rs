// INDEPENDENT MONERO KEY-IMAGE ORACLE.
//
// This binary exists to disagree with the SDK. It uses `monero-ed25519`, whose `Point::biased_hash`
// is a separate constant-time implementation of Monero's `ge_fromfe_frombytes_vartime` +
// `ge_mul8`, not a copy of `engine/monero/keyImage.js`. It never imports the SDK.
//
// The binary reads one JSON object from stdin and writes one JSON object to stdout:
//   {"requests": [{"op": "biased_hash_to_ec", "input": "<hex>"}, ...]}
// It is a test tool only; it is not part of the SDK runtime.
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT, scalar::Scalar};
use monero_ed25519::Point;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use std::io::{self, Read};

#[derive(Deserialize)]
struct Request {
    op: String,
    #[serde(default)]
    input: String,
    #[serde(default)]
    output_key: String,
    #[serde(default)]
    private_spend_key: String,
    #[serde(default)]
    derivation: String,
    #[serde(default)]
    index: u32,
    #[serde(default)]
    seed: String,
}

#[derive(Serialize)]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    key_image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scalar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn bytes32(value: &str) -> Result<[u8; 32], String> {
    let raw = hex::decode(value).map_err(|e| format!("invalid hex: {e}"))?;
    raw.try_into().map_err(|_| "expected 32 bytes".to_string())
}

fn scalar(value: &str) -> Result<Scalar, String> {
    Ok(Scalar::from_bytes_mod_order(bytes32(value)?))
}

fn varint(value: u32) -> Vec<u8> {
    let mut out = Vec::new();
    let mut n = value as u64;
    loop {
        let low = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(low);
            return out;
        }
        out.push(low | 0x80);
    }
}

fn hash_to_scalar(bytes: &[u8]) -> Scalar {
    Scalar::from_bytes_mod_order(Keccak256::digest(bytes).into())
}

fn key_image_for(output_key: &[u8; 32], spend: Scalar) -> String {
    let point = Point::biased_hash(*output_key);
    let image = point.into() * spend;
    hex::encode(image.compress().to_bytes())
}

fn execute(request: &Request) -> Result<Response, String> {
    match request.op.as_str() {
        "biased_hash_to_ec" => {
            let point = Point::biased_hash(bytes32(&request.input)?);
            Ok(Response {
                ok: true,
                output: Some(hex::encode(point.compress().to_bytes())),
                output_key: None,
                key_image: None,
                scalar: None,
                error: None,
            })
        }
        "key_image" => {
            let spend = scalar(&request.private_spend_key)?;
            Ok(Response {
                ok: true,
                output: None,
                output_key: Some(request.output_key.clone()),
                key_image: Some(key_image_for(&bytes32(&request.output_key)?, spend)),
                scalar: None,
                error: None,
            })
        }
        "derive_key_image" => {
            let spend = scalar(&request.private_spend_key)?;
            let mut preimage = hex::decode(&request.derivation).map_err(|e| format!("invalid derivation: {e}"))?;
            preimage.extend_from_slice(&varint(request.index));
            let x = hash_to_scalar(&preimage) + spend;
            let output = (ED25519_BASEPOINT_POINT * x).compress().to_bytes();
            Ok(Response {
                ok: true,
                output: None,
                output_key: Some(hex::encode(output)),
                key_image: Some(key_image_for(&output, x)),
                scalar: Some(hex::encode(x.to_bytes())),
                error: None,
            })
        }
        "generate" => {
            let seed = bytes32(&request.seed)?;
            let mut labelled = seed.to_vec();
            labelled.extend_from_slice(b"key-image-oracle");
            let spend = hash_to_scalar(&labelled);
            let output = (ED25519_BASEPOINT_POINT * spend).compress().to_bytes();
            Ok(Response {
                ok: true,
                output: None,
                output_key: Some(hex::encode(output)),
                key_image: Some(key_image_for(&output, spend)),
                scalar: Some(hex::encode(spend.to_bytes())),
                error: None,
            })
        }
        other => Err(format!("unknown op: {other}")),
    }
}

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).expect("read stdin");
    let value: serde_json::Value = serde_json::from_str(&input).expect("parse JSON");
    let requests: Vec<Request> = serde_json::from_value(value["requests"].clone()).expect("parse requests");
    let responses: Vec<Response> = requests
        .iter()
        .map(|request| match execute(request) {
            Ok(response) => response,
            Err(error) => Response { ok: false, output: None, output_key: None, key_image: None, scalar: None, error: Some(error) },
        })
        .collect();
    println!("{}", serde_json::to_string(&serde_json::json!({ "results": responses })).unwrap());
}
