# SOL's own WhatsApp channel

SOL supports a dedicated WhatsApp linked-device account whose role is **assistant interface + delivery/action channel**. It is intentionally separate from the WhatsApp accounts that SOL monitors as household sources.

## Two different WhatsApp roles

```text
Member WhatsApp accounts
        ↓
      SOURCES
        ↓
       Life

Dedicated SOL WhatsApp
        ↕
 ASSISTANT INTERFACE
        +
 DELIVERY/ACTION CHANNEL
```

The dedicated SOL account does not import normal chat history into Life and does not run the source-message candidate filter. Its realtime direct messages are handled by the assistant interface pipeline instead.

## Setup

Open:

```text
http://127.0.0.1:3000/sol-whatsapp
```

An owner/adult creates the household's single `WhatsApp de SOL` account and links the dedicated phone/account using WhatsApp Linked Devices. QR is the preferred path; pairing code remains available as a fallback.

The linked-device credentials use the same encrypted PostgreSQL auth store as the normal WhatsApp connector. The local encryption key stays under `.sol/secrets/` and is not stored in PostgreSQL or Git.

## Member identity binding

A WhatsApp sender does not gain command authority merely because a phone number looks familiar.

Each logged-in SOL member chooses **Vincular mi WhatsApp**. SOL creates a random, one-time code such as:

```text
SOL-1A2B3C4D
```

Only its SHA-256 hash is persisted. The code expires after 10 minutes.

The member sends that code from their own WhatsApp directly to SOL's dedicated account. SOL then records the actual WhatsApp JID delivered by the protocol, including an alternate JID when available. This works with WhatsApp's newer LID addressing without requiring SOL to infer identity from display names or manually entered phone numbers.

A currently active WhatsApp JID cannot authenticate two household members at the same time. Bindings can be revoked from the member's SOL session.

## Command authority

Only a verified direct sender mapped to an active SOL member can issue assistant commands.

Unknown senders:

- are not passed to Codex;
- are not written to the authenticated assistant interaction log;
- receive only a neutral instruction explaining how to bind a SOL member account;
- cannot approve proposals or execute actions.

Group chats, status/broadcast traffic and newsletters are not command surfaces.

## Deterministic commands

Some commands are deliberately resolved without AI:

```text
¿qué tengo hoy?       → today brief
agenda mañana          → tomorrow brief
pendientes             → pending proposals
sí / no                → last proposal SOL explicitly asked about
aprobar ABCD1234       → specific pending proposal
rechazar ABCD1234      → specific pending proposal
```

`yes/no` never means a general authorization. It is tied to `last_proposal_id` for that member and SOL WhatsApp account.

## Natural-language creation

Authenticated commands such as:

```text
recordame comprar filtros mañana
agendame dentista el viernes a las 16
```

may use Codex to structure a new **pending executive proposal**. Codex cannot execute the action. SOL returns the proposal to the member and asks for confirmation. Approval then reuses the normal Executive Core authorization and action path.

## Questions

Ordinary questions can use Codex with permission-filtered executive context (agenda, tasks and proposals visible to that member). The assistant prompt explicitly has no write authority.

As more first-class connectors arrive, this context can grow through the same authorized SOL retrieval layer rather than giving WhatsApp or Codex direct provider access.

## Automatic delivery

The executive layer emits durable outbox events for new persisted briefs and proposals:

```text
executive.brief.created
executive.proposal.created
```

The SOL WhatsApp delivery adapter sends:

- morning/tomorrow briefs to the corresponding verified member;
- private proposals to their member owner;
- family proposals only to verified owner/adult managers.

A delivery ledger prevents the normal outbox retry path from intentionally sending the same aggregate twice. External messaging itself is still an at-least-once boundary, so reconciliation must remain conservative if a remote send succeeds but the local success acknowledgement is lost.

Outbound assistant messages are recorded in the SOL interaction audit and `action_log`.

## Privacy behavior

The assistant account is excluded from the ordinary `/whatsapp` monitored-source inventory. Its direct assistant interactions have a separate table and are not silently mixed into member WhatsApp source history.

This preserves the distinction:

```text
What another person told a member  = untrusted source data
What a verified member told SOL    = authenticated interface input
```

## Current test boundary

The code path and deterministic intent tests are implemented, but a real dedicated-number linked-device test still needs to run on the target SOL host. That test should cover:

1. QR linking;
2. one-time member binding;
3. LID/alternate-JID recognition;
4. a read-only agenda question;
5. creation of a pending proposal;
6. `sí/no` approval;
7. automatic brief/proposal delivery;
8. reconnect/restart behavior.
