from __future__ import annotations

import os
import secrets

from argon2.low_level import Type, hash_secret_raw
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

AAD_DEK = b"melecho-dek-v1"

# Argon2id v1 — do not change without a migration.
KDF_TIME = 3
KDF_MEMORY = 65536
KDF_PARALLELISM = 4
KDF_HASH_LEN = 32
KDF_SALT_LEN = 16
KDF_VERSION = 19


def kdf_kek(password: str, salt: bytes) -> bytes:
    if len(password) < 12:
        raise ValueError("master password too short")
    return hash_secret_raw(
        secret=password.encode("utf-8"),
        salt=salt,
        time_cost=KDF_TIME,
        memory_cost=KDF_MEMORY,
        parallelism=KDF_PARALLELISM,
        hash_len=KDF_HASH_LEN,
        type=Type.ID,
        version=KDF_VERSION,
    )


def generate_salt() -> bytes:
    return secrets.token_bytes(KDF_SALT_LEN)


def generate_dek() -> bytes:
    return secrets.token_bytes(32)


def generate_audit_key() -> bytes:
    return secrets.token_bytes(32)


def wrap_dek(kek: bytes, dek: bytes) -> str:
    nonce = os.urandom(12)
    aes = AESGCM(kek)
    ct = aes.encrypt(nonce, dek, AAD_DEK)  # ciphertext||tag
    return (nonce + ct).hex()


def unwrap_dek(kek: bytes, blob_hex: str) -> bytes:
    blob = bytes.fromhex(blob_hex)
    nonce, rest = blob[:12], blob[12:]
    return AESGCM(kek).decrypt(nonce, rest, AAD_DEK)


def encrypt_secret(dek: bytes, plaintext: bytes, aad: bytes) -> tuple[str, str]:
    nonce = os.urandom(12)
    ct = AESGCM(dek).encrypt(nonce, plaintext, aad)
    return nonce.hex(), (ct).hex()


def decrypt_secret(dek: bytes, nonce_hex: str, ct_hex: str, aad: bytes) -> bytes:
    nonce = bytes.fromhex(nonce_hex)
    ct = bytes.fromhex(ct_hex)
    return AESGCM(dek).decrypt(nonce, ct, aad)


def aad_cred(server_id: int, version: int) -> bytes:
    return f"{server_id}|cred-v{version}".encode("utf-8")


def aad_passphrase(server_id: int, version: int) -> bytes:
    return f"{server_id}|pp-v{version}".encode("utf-8")


AAD_LLM = b"melecho-llm-key-v1"  # legacy: один ключ в settings
AAD_PROFILE_EXPORT = b"melecho-profile-export-v1"


def aad_llm_profile(profile_id: int, version: int) -> bytes:
    """AAD для ключа конкретного LLM-профиля.

    Включает profile_id, чтобы нельзя было переставить ciphertext между
    профилями. version — для будущей ротации ключа (как в aad_cred).
    """
    return f"melecho-llm-key-v1|{profile_id}|v{version}".encode("utf-8")
