use aes_gcm::{
    Aes256Gcm, Nonce, Tag,
    aead::{AeadInPlace, KeyInit},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, SecondsFormat, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use hkdf::Hkdf;
use rand::{RngCore, rngs::OsRng};
use reqwest::{Client, StatusCode, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, time::Duration};
use uuid::Uuid;
use x25519_dalek::{PublicKey, StaticSecret};

const CONTENT_TYPE: &str = "application/vnd.multivibe.confidential-envelope+json";
const MAX_ATTESTATION_BYTES: usize = 32 * 1024;
const MAX_ENVELOPE_BYTES: usize = 100 * 1024 * 1024;
const MAX_EVIDENCE_LIFETIME_MS: i64 = 10 * 60_000;
const DEFAULT_MAX_EVIDENCE_AGE_MS: i64 = 5 * 60_000;
const CLOCK_SKEW_MS: i64 = 30_000;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Measurements {
    pub runtime: String,
    pub model: String,
    pub cpu_firmware: String,
    pub gpu_firmware: String,
    pub gpu_driver: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecurityState {
    pub debug: bool,
    pub tcb_status: String,
    pub cpu_memory_encrypted: bool,
    pub gpu_memory_encrypted: bool,
    pub operator_access_blocked: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidencePayload {
    pub version: String,
    pub evidence_id: String,
    pub challenge: String,
    pub issuer: String,
    pub issued_at: String,
    pub expires_at: String,
    pub runtime_id: String,
    pub model: String,
    pub region: String,
    pub recipient_public_key: String,
    pub measurements: Measurements,
    pub security: SecurityState,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvidenceDocument {
    version: String,
    key_id: String,
    payload: EvidencePayload,
    signature: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Capabilities {
    version: String,
    mode: String,
    evidence: EvidenceDocument,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustRoot {
    pub key_id: String,
    pub public_key: PublicJwk,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicJwk {
    pub kty: String,
    pub crv: String,
    pub x: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeProfile {
    pub model: String,
    pub regions: Vec<String>,
    pub measurements: Measurements,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustPolicy {
    pub roots: Vec<TrustRoot>,
    pub profiles: Vec<RuntimeProfile>,
    pub max_evidence_age_ms: Option<i64>,
}

#[derive(Debug)]
pub struct ConfidentialError {
    pub disposition: &'static str,
    pub code: &'static str,
    pub message: String,
}

impl ConfidentialError {
    pub(crate) fn not_sent(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            disposition: "not_sent",
            code,
            message: message.into(),
        }
    }

    fn uncertain(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            disposition: "execution_uncertain",
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug)]
pub struct ConfidentialReply {
    pub status: StatusCode,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Clone)]
pub struct ConfidentialClient {
    policy: TrustPolicy,
    client: Client,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestPolicy<'a> {
    privacy: &'static str,
    model: &'a str,
    path: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestAad<'a> {
    version: &'static str,
    request_id: &'a str,
    evidence_id: &'a str,
    expires_at: &'a str,
    policy: RequestPolicy<'a>,
    ephemeral_public_key: &'a str,
    nonce: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestEnvelope<'a> {
    #[serde(flatten)]
    aad: RequestAad<'a>,
    ciphertext: String,
    tag: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResponseEnvelope {
    version: String,
    response_to: String,
    evidence_id: String,
    nonce: String,
    ciphertext: String,
    tag: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponseAad<'a> {
    version: &'a str,
    response_to: &'a str,
    evidence_id: &'a str,
    nonce: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InnerResponse {
    version: String,
    status: u16,
    headers: Map<String, Value>,
    body: String,
}

fn canonical_json(value: &Value) -> Result<String, ConfidentialError> {
    match value {
        Value::Null => Ok("null".to_owned()),
        Value::Bool(_) | Value::Number(_) | Value::String(_) => serde_json::to_string(value)
            .map_err(|_| {
                ConfidentialError::not_sent(
                    "invalid_attestation",
                    "Attestation contains invalid JSON",
                )
            }),
        Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        )),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let members = keys
                .into_iter()
                .map(|key| {
                    Ok(format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(&values[key])?
                    ))
                })
                .collect::<Result<Vec<String>, ConfidentialError>>()?;
            Ok(format!("{{{}}}", members.join(",")))
        }
    }
}

fn decode<const N: usize>(value: &str, code: &'static str) -> Result<[u8; N], ConfidentialError> {
    let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| {
        ConfidentialError::not_sent(code, "Confidential value is not canonical base64url")
    })?;
    if bytes.len() != N || URL_SAFE_NO_PAD.encode(&bytes) != value {
        return Err(ConfidentialError::not_sent(
            code,
            "Confidential value has an invalid size",
        ));
    }
    bytes
        .try_into()
        .map_err(|_| ConfidentialError::not_sent(code, "Confidential value has an invalid size"))
}

fn decode_uncertain<const N: usize>(
    value: &str,
    code: &'static str,
) -> Result<[u8; N], ConfidentialError> {
    decode(value, code).map_err(|error| ConfidentialError::uncertain(code, error.message))
}

fn decode_uncertain_bytes(
    value: &str,
    maximum: usize,
    code: &'static str,
) -> Result<Vec<u8>, ConfidentialError> {
    let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| {
        ConfidentialError::uncertain(code, "Confidential value is not canonical base64url")
    })?;
    if bytes.len() > maximum || URL_SAFE_NO_PAD.encode(&bytes) != value {
        return Err(ConfidentialError::uncertain(
            code,
            "Confidential value has an invalid size",
        ));
    }
    Ok(bytes)
}

fn equal_text(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (*left ^ *right)
        })
        == 0
}

fn valid_identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric()
                || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'@' | b'+' | b'-' | b'/'))
        })
}

fn digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn parse_time(value: &str) -> Result<DateTime<Utc>, ConfidentialError> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| {
            ConfidentialError::not_sent("invalid_attestation", "Attestation timestamp is invalid")
        })
}

fn verify_evidence(
    capabilities: Capabilities,
    raw_payload: &Value,
    challenge: &str,
    model: &str,
    policy: &TrustPolicy,
    now: DateTime<Utc>,
) -> Result<EvidencePayload, ConfidentialError> {
    if capabilities.version != "mvci-capabilities-v1"
        || capabilities.mode != "confidential_verified"
        || capabilities.evidence.version != "mvci-attestation-document-v1"
        || capabilities.evidence.payload.version != "mvci-attestation-v1"
    {
        return Err(ConfidentialError::not_sent(
            "invalid_attestation",
            "Attestation version or mode is invalid",
        ));
    }
    let evidence = capabilities.evidence;
    let root = policy
        .roots
        .iter()
        .find(|root| root.key_id == evidence.key_id)
        .ok_or_else(|| {
            ConfidentialError::not_sent(
                "untrusted_attestation_root",
                "Attestation root is not trusted",
            )
        })?;
    if root.public_key.kty != "OKP" || root.public_key.crv != "Ed25519" {
        return Err(ConfidentialError::not_sent(
            "invalid_trust_policy",
            "Trust root must be an Ed25519 public key",
        ));
    }
    let verifying_key =
        VerifyingKey::from_bytes(&decode::<32>(&root.public_key.x, "invalid_trust_policy")?)
            .map_err(|_| {
                ConfidentialError::not_sent("invalid_trust_policy", "Trust root is invalid")
            })?;
    let signature =
        Signature::from_bytes(&decode::<64>(&evidence.signature, "invalid_attestation")?);
    verifying_key
        .verify(canonical_json(raw_payload)?.as_bytes(), &signature)
        .map_err(|_| {
            ConfidentialError::not_sent(
                "invalid_attestation_signature",
                "Attestation signature is invalid",
            )
        })?;
    let payload = evidence.payload;
    if !equal_text(&payload.challenge, challenge) {
        return Err(ConfidentialError::not_sent(
            "attestation_challenge_mismatch",
            "Attestation is not bound to this request",
        ));
    }
    if !equal_text(&payload.model, model) {
        return Err(ConfidentialError::not_sent(
            "attestation_model_mismatch",
            "Attestation is not bound to the requested model",
        ));
    }
    if Uuid::parse_str(&payload.evidence_id).is_err()
        || !valid_identifier(&payload.issuer, 192)
        || !valid_identifier(&payload.runtime_id, 192)
        || !valid_identifier(&payload.model, 200)
        || !valid_identifier(&payload.region, 63)
    {
        return Err(ConfidentialError::not_sent(
            "invalid_attestation",
            "Attestation identity is invalid",
        ));
    }
    decode::<32>(&payload.recipient_public_key, "invalid_recipient_key")?;
    let issued_at = parse_time(&payload.issued_at)?;
    let expires_at = parse_time(&payload.expires_at)?;
    let lifetime = expires_at
        .signed_duration_since(issued_at)
        .num_milliseconds();
    let maximum_age = policy
        .max_evidence_age_ms
        .unwrap_or(DEFAULT_MAX_EVIDENCE_AGE_MS);
    if lifetime <= 0 || lifetime > MAX_EVIDENCE_LIFETIME_MS {
        return Err(ConfidentialError::not_sent(
            "invalid_attestation",
            "Attestation lifetime is invalid",
        ));
    }
    if issued_at.timestamp_millis() > now.timestamp_millis() + CLOCK_SKEW_MS
        || issued_at.timestamp_millis() < now.timestamp_millis() - maximum_age
        || expires_at <= now
    {
        return Err(ConfidentialError::not_sent(
            "stale_attestation",
            "Attestation is stale or expired",
        ));
    }
    let security = &payload.security;
    if security.debug
        || security.tcb_status != "current"
        || !security.cpu_memory_encrypted
        || !security.gpu_memory_encrypted
        || !security.operator_access_blocked
    {
        return Err(ConfidentialError::not_sent(
            "ineligible_confidential_runtime",
            "Runtime security state is not eligible",
        ));
    }
    let profile = policy
        .profiles
        .iter()
        .find(|profile| profile.model == model && profile.regions.contains(&payload.region))
        .ok_or_else(|| {
            ConfidentialError::not_sent(
                "unapproved_runtime_profile",
                "Runtime model or region is not approved",
            )
        })?;
    let expected = &profile.measurements;
    let actual = &payload.measurements;
    let measurements = [
        (&expected.runtime, &actual.runtime),
        (&expected.model, &actual.model),
        (&expected.cpu_firmware, &actual.cpu_firmware),
        (&expected.gpu_firmware, &actual.gpu_firmware),
        (&expected.gpu_driver, &actual.gpu_driver),
    ];
    if measurements
        .iter()
        .any(|(expected, actual)| !digest(actual) || expected != actual)
    {
        return Err(ConfidentialError::not_sent(
            "measurement_mismatch",
            "Runtime measurements are not approved",
        ));
    }
    Ok(payload)
}

fn normalized_origin(base_url: &str) -> Result<Url, ConfidentialError> {
    let url = Url::parse(base_url).map_err(|_| {
        ConfidentialError::not_sent(
            "invalid_confidential_origin",
            "Confidential inference origin is invalid",
        )
    })?;
    let loopback = url
        .host_str()
        .is_some_and(|host| host == "localhost" || host == "::1" || host.starts_with("127."));
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
        || (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
    {
        return Err(ConfidentialError::not_sent(
            "invalid_confidential_origin",
            "Confidential inference requires HTTPS or loopback HTTP",
        ));
    }
    Ok(url)
}

fn derive_keys(
    secret: &StaticSecret,
    peer: &PublicKey,
    evidence: &EvidencePayload,
) -> Result<([u8; 32], [u8; 32]), ConfidentialError> {
    let shared = secret.diffie_hellman(peer);
    let evidence_value = serde_json::to_value(evidence).map_err(|_| {
        ConfidentialError::not_sent("local_crypto_failed", "Could not encode attestation")
    })?;
    let salt = Sha256::digest(canonical_json(&evidence_value)?.as_bytes());
    let hkdf = Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes());
    let mut request = [0_u8; 32];
    let mut response = [0_u8; 32];
    hkdf.expand(b"multivibe-confidential-request-v1", &mut request)
        .map_err(|_| {
            ConfidentialError::not_sent("local_crypto_failed", "Could not derive request key")
        })?;
    hkdf.expand(b"multivibe-confidential-response-v1", &mut response)
        .map_err(|_| {
            ConfidentialError::not_sent("local_crypto_failed", "Could not derive response key")
        })?;
    Ok((request, response))
}

async fn bounded_json(
    response: reqwest::Response,
    maximum: usize,
    uncertain: bool,
) -> Result<Value, ConfidentialError> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        return Err(if uncertain {
            ConfidentialError::uncertain(
                "confidential_response_too_large",
                "Confidential response exceeds the size limit",
            )
        } else {
            ConfidentialError::not_sent(
                "confidential_response_too_large",
                "Confidential response exceeds the size limit",
            )
        });
    }
    let bytes = response.bytes().await.map_err(|_| {
        if uncertain {
            ConfidentialError::uncertain(
                "confidential_transport_failed",
                "Confidential response could not be read",
            )
        } else {
            ConfidentialError::not_sent(
                "confidential_transport_failed",
                "Confidential response could not be read",
            )
        }
    })?;
    if bytes.len() > maximum {
        return Err(if uncertain {
            ConfidentialError::uncertain(
                "confidential_response_too_large",
                "Confidential response exceeds the size limit",
            )
        } else {
            ConfidentialError::not_sent(
                "confidential_response_too_large",
                "Confidential response exceeds the size limit",
            )
        });
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        if uncertain {
            ConfidentialError::uncertain(
                "invalid_confidential_response",
                "Confidential response is not valid JSON",
            )
        } else {
            ConfidentialError::not_sent(
                "invalid_attestation",
                "Attestation response is not valid JSON",
            )
        }
    })
}

impl ConfidentialClient {
    pub fn new(policy_json: &str, timeout: Duration) -> Result<Self, ConfidentialError> {
        let policy: TrustPolicy = serde_json::from_str(policy_json).map_err(|_| {
            ConfidentialError::not_sent(
                "invalid_trust_policy",
                "Confidential trust policy is invalid",
            )
        })?;
        if policy.roots.is_empty() || policy.profiles.is_empty() {
            return Err(ConfidentialError::not_sent(
                "invalid_trust_policy",
                "Confidential trust policy requires roots and profiles",
            ));
        }
        let client = Client::builder()
            .redirect(Policy::none())
            .timeout(timeout)
            .build()
            .map_err(|_| {
                ConfidentialError::not_sent(
                    "local_configuration_failed",
                    "Could not create confidential HTTP client",
                )
            })?;
        Ok(Self { policy, client })
    }

    pub async fn execute(
        &self,
        base_url: &str,
        access_token: &str,
        model: &str,
        path: &str,
        body: &[u8],
    ) -> Result<ConfidentialReply, ConfidentialError> {
        if !matches!(path, "/v1/responses" | "/v1/chat/completions") {
            return Err(ConfidentialError::not_sent(
                "confidential_path_not_supported",
                "This request is not supported by verified confidential computing",
            ));
        }
        if access_token.is_empty()
            || access_token.len() > 8192
            || access_token.bytes().any(|byte| byte.is_ascii_whitespace())
        {
            return Err(ConfidentialError::not_sent(
                "invalid_confidential_credential",
                "Confidential inference credential is invalid",
            ));
        }
        if body.len() > MAX_ENVELOPE_BYTES {
            return Err(ConfidentialError::not_sent(
                "confidential_request_too_large",
                "Confidential request exceeds the size limit",
            ));
        }
        let origin = normalized_origin(base_url)?;
        let mut challenge_bytes = [0_u8; 32];
        OsRng.fill_bytes(&mut challenge_bytes);
        let challenge = URL_SAFE_NO_PAD.encode(challenge_bytes);
        let mut capabilities_url = origin.join("/v1/confidential/capabilities").map_err(|_| {
            ConfidentialError::not_sent(
                "invalid_confidential_origin",
                "Confidential inference origin is invalid",
            )
        })?;
        capabilities_url
            .query_pairs_mut()
            .append_pair("challenge", &challenge)
            .append_pair("model", model);
        let response = self
            .client
            .get(capabilities_url)
            .header("accept", CONTENT_TYPE)
            .send()
            .await
            .map_err(|_| {
                ConfidentialError::not_sent(
                    "attestation_unavailable",
                    "The protected destination could not be verified. The message was not sent.",
                )
            })?;
        if !response.status().is_success() {
            return Err(ConfidentialError::not_sent(
                "attestation_unavailable",
                "The protected destination could not be verified. The message was not sent.",
            ));
        }
        let capabilities_value = bounded_json(response, MAX_ATTESTATION_BYTES, false).await?;
        let raw_payload = capabilities_value
            .pointer("/evidence/payload")
            .cloned()
            .ok_or_else(|| {
                ConfidentialError::not_sent("invalid_attestation", "Attestation payload is missing")
            })?;
        let capabilities: Capabilities =
            serde_json::from_value(capabilities_value).map_err(|_| {
                ConfidentialError::not_sent(
                    "invalid_attestation",
                    "Attestation response has an invalid shape",
                )
            })?;
        let evidence = verify_evidence(
            capabilities,
            &raw_payload,
            &challenge,
            model,
            &self.policy,
            Utc::now(),
        )?;

        let secret = StaticSecret::random_from_rng(OsRng);
        let public = PublicKey::from(&secret);
        let recipient = PublicKey::from(decode::<32>(
            &evidence.recipient_public_key,
            "invalid_recipient_key",
        )?);
        let (request_key, response_key) = derive_keys(&secret, &recipient, &evidence)?;
        let request_id = Uuid::new_v4().to_string();
        let evidence_expiry = parse_time(&evidence.expires_at)?;
        let expires_at = std::cmp::min(evidence_expiry, Utc::now() + chrono::Duration::seconds(60))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        let ephemeral_public_key = URL_SAFE_NO_PAD.encode(public.as_bytes());
        let mut nonce_bytes = [0_u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
        let aad = RequestAad {
            version: "mvci-1",
            request_id: &request_id,
            evidence_id: &evidence.evidence_id,
            expires_at: &expires_at,
            policy: RequestPolicy {
                privacy: "confidential_verified",
                model,
                path,
            },
            ephemeral_public_key: &ephemeral_public_key,
            nonce: &nonce,
        };
        let inner = serde_json::json!({
            "version": "mvci-inner-request-v1", "method": "POST", "path": path,
            "headers": {"content-type": "application/json"}, "body": URL_SAFE_NO_PAD.encode(body),
        });
        let mut clear = canonical_json(&inner)?.into_bytes();
        let aad_bytes = canonical_json(&serde_json::to_value(&aad).map_err(|_| {
            ConfidentialError::not_sent(
                "local_crypto_failed",
                "Could not encode confidential request",
            )
        })?)?;
        let cipher = Aes256Gcm::new_from_slice(&request_key).map_err(|_| {
            ConfidentialError::not_sent("local_crypto_failed", "Could not create request cipher")
        })?;
        let tag = cipher
            .encrypt_in_place_detached(
                Nonce::from_slice(&nonce_bytes),
                aad_bytes.as_bytes(),
                &mut clear,
            )
            .map_err(|_| {
                ConfidentialError::not_sent(
                    "local_crypto_failed",
                    "Could not encrypt confidential request",
                )
            })?;
        let envelope = RequestEnvelope {
            aad,
            ciphertext: URL_SAFE_NO_PAD.encode(clear),
            tag: URL_SAFE_NO_PAD.encode(tag),
        };
        let execution_url = origin.join("/v1/confidential/responses").map_err(|_| {
            ConfidentialError::not_sent(
                "invalid_confidential_origin",
                "Confidential inference origin is invalid",
            )
        })?;
        let execution = self
            .client
            .post(execution_url)
            .header("accept", CONTENT_TYPE)
            .header("content-type", CONTENT_TYPE)
            .bearer_auth(access_token)
            .json(&envelope)
            .send()
            .await
            .map_err(|_| {
                ConfidentialError::uncertain(
                    "confidential_transport_failed",
                    "The confidential execution outcome is uncertain",
                )
            })?;
        if !execution.status().is_success() {
            let not_sent = execution
                .headers()
                .get("x-multivibe-execution-state")
                .and_then(|value| value.to_str().ok())
                == Some("not_sent");
            return Err(if not_sent {
                ConfidentialError::not_sent(
                    "confidential_request_not_sent",
                    "The protected runtime did not start the request",
                )
            } else {
                ConfidentialError::uncertain(
                    "confidential_execution_uncertain",
                    "The confidential execution outcome is uncertain",
                )
            });
        }
        let sealed: ResponseEnvelope =
            serde_json::from_value(bounded_json(execution, MAX_ENVELOPE_BYTES, true).await?)
                .map_err(|_| {
                    ConfidentialError::uncertain(
                        "invalid_confidential_response",
                        "The confidential response has an invalid shape",
                    )
                })?;
        if sealed.version != "mvci-1"
            || !equal_text(&sealed.response_to, &request_id)
            || !equal_text(&sealed.evidence_id, &evidence.evidence_id)
        {
            return Err(ConfidentialError::uncertain(
                "confidential_response_binding_failed",
                "The confidential response does not match this request",
            ));
        }
        let response_nonce =
            decode_uncertain::<12>(&sealed.nonce, "invalid_confidential_response")?;
        let tag = decode_uncertain::<16>(&sealed.tag, "invalid_confidential_response")?;
        let mut ciphertext = decode_uncertain_bytes(
            &sealed.ciphertext,
            MAX_ENVELOPE_BYTES,
            "invalid_confidential_response",
        )?;
        let response_aad = ResponseAad {
            version: &sealed.version,
            response_to: &sealed.response_to,
            evidence_id: &sealed.evidence_id,
            nonce: &sealed.nonce,
        };
        let aad = canonical_json(&serde_json::to_value(&response_aad).map_err(|_| {
            ConfidentialError::uncertain(
                "invalid_confidential_response",
                "Could not encode response binding",
            )
        })?)?;
        let cipher = Aes256Gcm::new_from_slice(&response_key).map_err(|_| {
            ConfidentialError::uncertain("local_crypto_failed", "Could not create response cipher")
        })?;
        cipher
            .decrypt_in_place_detached(
                Nonce::from_slice(&response_nonce),
                aad.as_bytes(),
                &mut ciphertext,
                Tag::from_slice(&tag),
            )
            .map_err(|_| {
                ConfidentialError::uncertain(
                    "confidential_response_authentication_failed",
                    "The confidential response could not be authenticated",
                )
            })?;
        let inner: InnerResponse = serde_json::from_slice(&ciphertext).map_err(|_| {
            ConfidentialError::uncertain(
                "invalid_confidential_response",
                "Confidential inner response is invalid",
            )
        })?;
        if inner.version != "mvci-inner-response-v1" || !(100..=599).contains(&inner.status) {
            return Err(ConfidentialError::uncertain(
                "invalid_confidential_response",
                "Confidential inner response is invalid",
            ));
        }
        let allowed = HashSet::from([
            "content-type",
            "request-id",
            "openai-request-id",
            "anthropic-request-id",
        ]);
        let mut headers = Vec::new();
        for (name, value) in inner.headers {
            let name = name.to_ascii_lowercase();
            let Some(value) = value.as_str() else {
                return Err(ConfidentialError::uncertain(
                    "invalid_confidential_response",
                    "Confidential response header is invalid",
                ));
            };
            if !allowed.contains(name.as_str())
                || value.len() > 1024
                || value.contains('\r')
                || value.contains('\n')
            {
                return Err(ConfidentialError::uncertain(
                    "invalid_confidential_response",
                    "Confidential response header is invalid",
                ));
            }
            headers.push((name, value.to_owned()));
        }
        let body = decode_uncertain_bytes(
            &inner.body,
            MAX_ENVELOPE_BYTES,
            "invalid_confidential_response",
        )?;
        Ok(ConfidentialReply {
            status: StatusCode::from_u16(inner.status).map_err(|_| {
                ConfidentialError::uncertain(
                    "invalid_confidential_response",
                    "Confidential response status is invalid",
                )
            })?,
            headers,
            body,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evidence() -> EvidencePayload {
        EvidencePayload {
            version: "mvci-attestation-v1".to_owned(),
            evidence_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            challenge: URL_SAFE_NO_PAD.encode([3_u8; 32]),
            issuer: "test-attester".to_owned(),
            issued_at: "2026-09-07T12:00:00.000Z".to_owned(),
            expires_at: "2026-09-07T12:01:00.000Z".to_owned(),
            runtime_id: "runtime-test-1".to_owned(),
            model: "verified-model".to_owned(),
            region: "eu-test-1".to_owned(),
            recipient_public_key: URL_SAFE_NO_PAD.encode([4_u8; 32]),
            measurements: Measurements {
                runtime: format!("sha256:{}", "1".repeat(64)),
                model: format!("sha256:{}", "2".repeat(64)),
                cpu_firmware: format!("sha256:{}", "3".repeat(64)),
                gpu_firmware: format!("sha256:{}", "4".repeat(64)),
                gpu_driver: format!("sha256:{}", "5".repeat(64)),
            },
            security: SecurityState {
                debug: false,
                tcb_status: "current".to_owned(),
                cpu_memory_encrypted: true,
                gpu_memory_encrypted: true,
                operator_access_blocked: true,
            },
        }
    }

    #[test]
    fn canonical_json_sorts_object_keys_recursively() {
        assert_eq!(
            canonical_json(&serde_json::json!({"z": 1, "a": {"y": 2, "b": 3}})).unwrap(),
            r#"{"a":{"b":3,"y":2},"z":1}"#
        );
    }

    #[test]
    fn rejects_non_https_non_loopback_origins() {
        let error = normalized_origin("http://example.com").unwrap_err();
        assert_eq!(error.code, "invalid_confidential_origin");
        assert!(normalized_origin("http://127.0.0.1:1455").is_ok());
        assert!(normalized_origin("https://api.example.com").is_ok());
    }

    #[test]
    fn x25519_keys_are_symmetric_and_domain_separated() {
        let left = StaticSecret::from([1_u8; 32]);
        let right = StaticSecret::from([2_u8; 32]);
        let left_public = PublicKey::from(&left);
        let right_public = PublicKey::from(&right);
        let left_keys = derive_keys(&left, &right_public, &evidence()).unwrap();
        let right_keys = derive_keys(&right, &left_public, &evidence()).unwrap();
        assert_eq!(left_keys, right_keys);
        assert_ne!(left_keys.0, left_keys.1);
    }

    #[test]
    fn malformed_response_values_are_execution_uncertain() {
        let error =
            decode_uncertain::<12>("not-base64url!", "invalid_confidential_response").unwrap_err();
        assert_eq!(error.disposition, "execution_uncertain");
        assert_eq!(error.code, "invalid_confidential_response");
    }
}
