# Managed deployment for MultiVibe Team

MultiVibe Host can be installed and enrolled without employee interaction by an
MDM or endpoint-management product such as Jamf, Kandji, Microsoft Intune,
Workspace ONE, or a managed Linux fleet tool.

Managed enrollment is separate from Team machine sharing. Enrollment connects
the installation to the employee's existing Team membership. It does not grant
remote runtime management or enable inference sharing. That still requires the
machine owner's explicit, organization-bound Team consent.

## Security model

The Team administrator creates one short-lived bootstrap profile for one active
membership and one deployment target. The profile expires in at most 24 hours
and its `mvmb_` credential can be consumed only once. A successful retry is
idempotent only for the same profile and locally generated instance identity.

The profile never contains an employee Team API key, an OAuth refresh token, or
an instance private key. On first start MultiVibe:

1. creates the Ed25519 signing and X25519 encryption keys in its private local
   data directory;
2. signs the managed-enrollment request with the new instance identity;
3. exchanges the bootstrap over `https://app.multivibe.cloud`;
4. verifies that the returned organization, membership, instance, management
   channel, and device claim exactly match the profile;
5. installs the once-shown employee Team key and the instance-scoped access
   and rotating refresh grants in the private local store; and
6. deletes the bootstrap profile.

The Cloud exchange must atomically mark a bootstrap as used before issuing
credentials. It must reject an inactive membership, expired Team subscription,
seat/instance-capacity failure, organization mismatch, device-claim mismatch,
replay from another instance, or invalid proof of possession. Request bodies,
authorization headers, and returned secrets must never be logged.

Owners and Team administrators create the profile with
`POST /client/v1/team/managed-enrollments`; the exact input fields are
`membershipId`, `managementChannel`, `deviceClaim`, `instanceName`, and
`expiresInSeconds`. The response is the complete profile and is intentionally
shown only on creation. `GET /client/v1/team/managed-enrollments` returns the
redacted inventory, and `DELETE /client/v1/team/managed-enrollments/:profileId`
revokes an unconsumed profile. Billing and member roles cannot use these
administration endpoints.

The public local status exposes identifiers, enrollment state, management
channel, and the Team-key prefix only. It never returns bootstrap, access-token,
personal-key, or private-key material.

Before an instance access grant expires, Host signs a refresh proof with the
same local Ed25519 identity and sends the `mvir_` credential only in the
Authorization header to `POST /team/v1/instances/managed-refresh`. Cloud
rotates both managed grants atomically. Reuse of the previous refresh
credential revokes the managed session.

## Device channel and user channel

- `device` is for a company-assigned computer. `deviceClaim` is mandatory and
  contains an issuer, a stable inventory subject already known by the MDM (such
  as an Apple serial or Intune managed-device ID), and a Cloud-generated nonce.
  Cloud compares all three with the claim recorded when the admin created the
  bootstrap.
- `user` is for a per-user deployment or a shared computer. The profile is
  assigned to one MDM user and is installed in that user's MultiVibe data
  directory. `deviceClaim` may be `null`.

Do not deploy one employee's profile to a device group. Generate one profile per
membership and target. Reassignment or organization transfer requires a new
bootstrap and a new explicit machine-sharing consent.

## Profile format

The authoritative schema is
`packaging/schemas/multivibe-managed-enrollment-v1.schema.json`. Times are Unix
milliseconds. This example contains placeholders, not usable credentials:

```json
{
  "schemaVersion": "multivibe-managed-enrollment-v1",
  "profileId": "00000000-0000-4000-8000-000000000001",
  "managementChannel": "device",
  "organizationId": "00000000-0000-4000-8000-000000000002",
  "membershipId": "00000000-0000-4000-8000-000000000003",
  "deviceClaim": {
    "issuer": "com.example.mdm.inventory",
    "subject": "serial:MDM-INVENTORY-ID",
    "nonce": "REPLACE_WITH_CLOUD_GENERATED_NONCE"
  },
  "instanceName": "Employee laptop",
  "bootstrapToken": "mvmb_REPLACE_WITH_THE_ONCE_SHOWN_BOOTSTRAP",
  "cloudApiOrigin": "https://app.multivibe.cloud",
  "issuedAt": 0,
  "expiresAt": 1
}
```

## Deployment sequence

1. In the Team dashboard, select an active employee and generate a managed
   enrollment for either the device or user channel. Download the profile once.
2. Assign the signed MultiVibe Host release and that profile to the same single
   target in the MDM. Treat the profile as a secret and suppress script output.
3. Run the platform installer in the target employee's context with
   `--managed-profile /absolute/private/staging/profile.json` on macOS/Linux or
   `-ManagedProfilePath C:\absolute\private\staging\profile.json` on Windows.
4. The installer verifies the source is private, copies it atomically to the
   per-user data directory, and removes the staging file. Host retries temporary
   Cloud failures while the profile remains valid.
5. Confirm `enrolled` for the expected membership, instance, channel, and device
   claim in the Team dashboard. A queued install or successful package command
   is not enrollment proof.

Current per-user managed-profile destinations are:

| Platform | Destination |
| --- | --- |
| macOS | `~/Library/Application Support/MultiVibe/managed-team-enrollment.json` |
| Windows | `%LOCALAPPDATA%\MultiVibe\managed-team-enrollment.json` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/multivibe/managed-team-enrollment.json` |

Jamf and Kandji should run the installer through their logged-in-user mechanism;
Intune should use a user-context Win32 deployment; Linux managers should run the
installer as the target desktop user. Running a per-user installer as root or
SYSTEM would enroll the wrong profile and is rejected by the profile ownership
checks.

## Rotation and removal

Revoking the employee's Team membership revokes the managed Team key and
instance access. Removing or suspending Team machine sharing is a separate
operation. Uninstalling Host does not delete Cloud audit history; the Team admin
must revoke or transfer the instance in the dashboard.
