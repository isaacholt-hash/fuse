//! Sync's authenticated encryption and per-installation signatures. No key has Debug/Display.
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

pub const PROTOCOL: u32 = 1;
pub const MAX_PACKET_BYTES: usize = 4 * 1024 * 1024;
const DOMAIN: &[u8] = b"FUSE sync envelope v1\0";

pub fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).map_err(|_| "The OS couldn't generate sync randomness.")?;
    Ok(bytes)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn decode(value: &str, limit: usize) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(2) || value.len() / 2 > limit {
        return Err("Sync data has an invalid encoding or size.".into());
    }
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let digit = |b: u8| match b {
                b'0'..=b'9' => Some(b - b'0'),
                b'a'..=b'f' => Some(b - b'a' + 10),
                _ => None,
            };
            Ok(
                digit(pair[0]).ok_or("Sync data has an invalid encoding.")? * 16
                    + digit(pair[1]).ok_or("Sync data has an invalid encoding.")?,
            )
        })
        .collect()
}

pub fn key(value: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    let decoded = Zeroizing::new(decode(value, 32)?);
    let bytes: [u8; 32] = decoded
        .as_slice()
        .try_into()
        .map_err(|_| "A sync key is damaged. Recover sync before continuing.")?;
    Ok(Zeroizing::new(bytes))
}

pub fn public(signing: &str) -> Result<String, String> {
    Ok(hex(&SigningKey::from_bytes(&*key(signing)?)
        .verifying_key()
        .to_bytes()))
}

pub fn verifying(public: &str) -> Result<VerifyingKey, String> {
    let bytes: [u8; 32] = decode(public, 32)?
        .try_into()
        .map_err(|_| "Invalid sync device identity.")?;
    let key = VerifyingKey::from_bytes(&bytes).map_err(|_| "Invalid sync device identity.")?;
    if key.is_weak() {
        return Err("Invalid sync device identity.".into());
    }
    Ok(key)
}

/// Only routing metadata is visible to the relay. Entity names, file names and hashes live
/// inside the encrypted body. Every header field is both associated data and signed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Header {
    pub protocol: u32,
    pub schema: i64,
    pub workspace_id: String,
    pub user_id: String,
    pub dataset_id: String,
    pub epoch: u64,
    pub device_id: String,
    pub event_id: String,
    pub seq: u64,
    pub clock: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope {
    pub header: Header,
    pub nonce: String,
    pub ciphertext: String,
    pub signature: String,
}

fn associated(header: &Header) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(header).map_err(|_| "Couldn't encode sync metadata.")?;
    let mut bytes = DOMAIN.to_vec();
    bytes.extend_from_slice(&(json.len() as u64).to_be_bytes());
    bytes.extend_from_slice(&json);
    Ok(bytes)
}

pub fn seal(
    header: Header,
    body: &[u8],
    encryption: &str,
    signing: &str,
) -> Result<Envelope, String> {
    if body.len() > MAX_PACKET_BYTES {
        return Err("This sync packet is too large.".into());
    }
    let nonce = random::<24>()?;
    let aad = associated(&header)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key(encryption)?.as_ref())
        .map_err(|_| "Invalid sync encryption key.")?;
    let ciphertext = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: body,
                aad: &aad,
            },
        )
        .map_err(|_| "Couldn't encrypt sync data.")?;
    let mut signed = aad;
    signed.extend_from_slice(&nonce);
    signed.extend_from_slice(&ciphertext);
    let signature = SigningKey::from_bytes(&*key(signing)?).sign(&signed);
    Ok(Envelope {
        header,
        nonce: hex(&nonce),
        ciphertext: hex(&ciphertext),
        signature: hex(&signature.to_bytes()),
    })
}

pub fn open(
    envelope: &Envelope,
    expected: &Header,
    encryption: &str,
    public: &str,
) -> Result<Zeroizing<Vec<u8>>, String> {
    if &envelope.header != expected || expected.protocol != PROTOCOL {
        return Err("Sync's protocol, schema, workspace or key epoch doesn't match. Update or recover sync.".into());
    }
    let nonce: [u8; 24] = decode(&envelope.nonce, 24)?
        .try_into()
        .map_err(|_| "Invalid sync nonce.")?;
    let ciphertext = decode(&envelope.ciphertext, MAX_PACKET_BYTES + 16)?;
    let signature: [u8; 64] = decode(&envelope.signature, 64)?
        .try_into()
        .map_err(|_| "Invalid sync signature.")?;
    let aad = associated(&envelope.header)?;
    let mut signed = aad.clone();
    signed.extend_from_slice(&nonce);
    signed.extend_from_slice(&ciphertext);
    verifying(public)?
        .verify_strict(&signed, &Signature::from_bytes(&signature))
        .map_err(|_| "Sync data failed device signature verification. Nothing was applied.")?;
    let cipher = XChaCha20Poly1305::new_from_slice(key(encryption)?.as_ref())
        .map_err(|_| "Invalid sync encryption key.")?;
    cipher
        .decrypt(
            &XNonce::from(nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| "Sync data couldn't be authenticated. Nothing was applied.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn header() -> Header {
        Header {
            protocol: PROTOCOL,
            schema: 57,
            workspace_id: "fixture-workspace".into(),
            user_id: "fixture-user".into(),
            dataset_id: "fixture-dataset".into(),
            epoch: 1,
            device_id: "fixture-device".into(),
            event_id: "fixture-device:1".into(),
            seq: 1,
            clock: 1,
        }
    }
    #[test]
    fn encrypts_authenticates_and_uses_a_fresh_nonce() {
        let encryption = Zeroizing::new(hex(&random::<32>().unwrap()));
        let signing = Zeroizing::new(hex(&random::<32>().unwrap()));
        let public = public(&signing).unwrap();
        let a = seal(header(), b"private fixture text", &encryption, &signing).unwrap();
        let b = seal(header(), b"private fixture text", &encryption, &signing).unwrap();
        assert_ne!(a.nonce, b.nonce);
        assert_eq!(
            open(&a, &header(), &encryption, &public)
                .unwrap()
                .as_slice(),
            b"private fixture text"
        );
        assert!(
            !serde_json::to_string(&a)
                .unwrap()
                .contains("private fixture text")
        );
        let wrong = hex(&random::<32>().unwrap());
        assert!(open(&a, &header(), &wrong, &public).is_err());
        assert!(open(&a, &header(), &encryption, &self::public(&wrong).unwrap()).is_err());
        // Even when routing metadata is accepted by the caller, changing it invalidates
        // the signature: authentication cannot rely only on the expected-header comparison.
        let mut changed = a.clone();
        changed.header.clock += 1;
        assert!(open(&changed, &changed.header, &encryption, &public).is_err());
        for field in [
            "protocol",
            "schema",
            "workspaceId",
            "userId",
            "datasetId",
            "epoch",
            "deviceId",
            "eventId",
            "seq",
            "clock",
            "nonce",
            "ciphertext",
            "signature",
        ] {
            let mut value = serde_json::to_value(&a).unwrap();
            let slot = if ["nonce", "ciphertext", "signature"].contains(&field) {
                &mut value[field]
            } else {
                &mut value["header"][field]
            };
            if slot.is_number() {
                *slot = serde_json::json!(999);
            } else {
                *slot = serde_json::json!("00");
            }
            let packet: Envelope = serde_json::from_value(value).unwrap();
            assert!(
                open(&packet, &header(), &encryption, &public).is_err(),
                "accepted modified {field}"
            );
        }
    }
    #[test]
    fn refuses_oversize_and_malformed_encodings_without_panicking() {
        assert!(decode("00", 0).is_err());
        assert!(decode("0", 1).is_err());
        assert!(decode("zz", 1).is_err());
        assert!(key("00").is_err());
        assert!(verifying(&"00".repeat(32)).is_err());
    }
}
