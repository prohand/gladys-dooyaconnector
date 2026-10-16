# Security policy

## Supported versions

Only the latest release of the Dooya Connector integration receives security fixes.
Update the integration from the Gladys store before reporting an issue.

| Version        | Supported |
| -------------- | --------- |
| latest release | Yes       |
| older          | No        |

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or forum
post.

Report it privately through GitHub: open the **Security** tab of
[prohand/gladys-dooyaconnector](https://github.com/prohand/gladys-dooyaconnector/security),
then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only asks the
maintainers for a private contact, without any detail of the problem, and send the
report there.

Include, when you can:

- the version of the integration and of Gladys;
- the model and firmware of the Connector hub;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove the key, tokens and addresses first).

You should get a first answer within 7 days. The fix ships as a new version of the
integration, and the advisory is published once users can update.

## Scope

In scope: the code of this repository and the Docker image it publishes.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)), the
Connector hub, its firmware, the Connector app and the cloud services of the
manufacturer.

## What the integration does with your data

- The **key of the Connector app** is stored by Gladys in a secret field. The
  integration uses it to compute the access token of each order, and never writes the
  key, the hub token or the access token to the logs.
- Everything stays on your network: the integration only talks to the hub, in unicast
  UDP on port 32100. It calls no cloud service.
- The "Find the hub" action asks the Gladys core to broadcast one discovery request on
  UDP port 32100 (declared in the manifest, shown on the install screen).

## Good practices for users

- Give the hub a fixed IP address, and keep it on a network you trust: the local
  protocol of the hub is not encrypted: the orders only carry an access token derived
  from the key.
- Keep Gladys and the integration up to date.
