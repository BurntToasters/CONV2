//! `{ ok, data } | { ok: false, error }` envelopes shared with the frontend.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A typed-first adapter for IPC payloads. Invalid shapes are retained as JSON
/// so command validators can return CONV2's normal error envelope instead of
/// letting Tauri reject the invocation during argument extraction.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum FalliblePayload<T> {
    Typed(T),
    Invalid(Value),
}

impl<T: Serialize> FalliblePayload<T> {
    #[allow(dead_code)]
    pub fn into_value(self) -> Value {
        match self {
            Self::Typed(value) => serde_json::to_value(value).unwrap_or(Value::Null),
            Self::Invalid(value) => value,
        }
    }

    /// The JSON the renderer sent for this field: the re-serialized typed
    /// value, or the raw value that failed the typed shape.
    #[allow(dead_code)]
    pub fn as_json(&self) -> Value {
        match self {
            Self::Typed(value) => serde_json::to_value(value).unwrap_or(Value::Null),
            Self::Invalid(value) => value.clone(),
        }
    }
}

impl<T> FalliblePayload<T> {
    /// The typed value, or the error a malformed shape maps to. Commands pass
    /// the message their `Value` validator used for that shape.
    pub fn into_typed(self, code: &'static str, message: &str) -> Result<T, IpcError> {
        match self {
            Self::Typed(value) => Ok(value),
            Self::Invalid(_) => Err(IpcError::new(code, message)),
        }
    }

    /// The typed value, or the raw JSON that did not match the type, for a
    /// validator that words its own message per shape.
    #[allow(dead_code)]
    pub fn into_result(self) -> Result<T, Value> {
        match self {
            Self::Typed(value) => Ok(value),
            Self::Invalid(raw) => Err(raw),
        }
    }
}

/// Deserializes a field that must be present to be typed. A missing key is
/// `None`; `null` and any other wrong type are `Invalid`, so a settings patch
/// refuses them field by field instead of treating them as absent.
#[allow(dead_code)]
pub fn present_payload<'de, D, T>(deserializer: D) -> Result<Option<FalliblePayload<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    FalliblePayload::<T>::deserialize(deserializer).map(Some)
}

/// Accepts only a JSON object for the inner struct. Without this, serde builds
/// a struct with all-default fields from `[]`, which the old `Value` path
/// refused as a non-object.
#[derive(Clone, Debug)]
pub struct JsonObject<T>(pub T);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for JsonObject<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor<T>(std::marker::PhantomData<T>);

        impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for ObjectVisitor<T> {
            type Value = JsonObject<T>;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a JSON object")
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                map: A,
            ) -> Result<Self::Value, A::Error> {
                T::deserialize(serde::de::value::MapAccessDeserializer::new(map)).map(JsonObject)
            }
        }

        deserializer.deserialize_map(ObjectVisitor(std::marker::PhantomData))
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct IpcError {
    #[cfg_attr(
        test,
        ts(
            type = "\"VALIDATION_ERROR\" | \"INVALID_PATH\" | \"NOT_AVAILABLE\" | \"INTERNAL_ERROR\""
        )
    )]
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

pub const VALIDATION_ERROR: &str = "VALIDATION_ERROR";
pub const INVALID_PATH: &str = "INVALID_PATH";
/// Part of the IPC error-code contract in the generated TypeScript union.
#[allow(dead_code)]
pub const NOT_AVAILABLE: &str = "NOT_AVAILABLE";
/// Reserved for the real command implementations (spawn and IO failures).
#[allow(dead_code)]
pub const INTERNAL_ERROR: &str = "INTERNAL_ERROR";

impl IpcError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct IpcResult<T: Serialize> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<IpcError>,
}

pub fn ok<T: Serialize>(data: T) -> IpcResult<T> {
    IpcResult {
        ok: true,
        data: Some(data),
        error: None,
    }
}

pub fn err<T: Serialize>(code: &'static str, message: impl Into<String>) -> IpcResult<T> {
    from_error(IpcError::new(code, message))
}

pub fn from_error<T: Serialize>(error: IpcError) -> IpcResult<T> {
    IpcResult {
        ok: false,
        data: None,
        error: Some(error),
    }
}

impl<T: Serialize> From<Result<T, IpcError>> for IpcResult<T> {
    fn from(value: Result<T, IpcError>) -> Self {
        match value {
            Ok(data) => ok(data),
            Err(error) => from_error(error),
        }
    }
}
