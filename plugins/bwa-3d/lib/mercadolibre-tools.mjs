export function createMercadoLibreTools(api) {
  const actionConfirm = {
    confirmedByUser: {
      type: "boolean",
      description: "Optional compatibility flag. SOL enforces confirmation at sol_run_action."
    }
  };

  const tools = [
    {
      name: "bwa_3d_mercadolibre_api_status",
      description: "Read BWA 3D seller-API OAuth configuration, authentication state, token expiry and write-mode state. Tokens and secrets are never returned.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      requiredScope: "read"
    },
    {
      name: "bwa_3d_mercadolibre_api_login",
      description: "Begin Mercado Libre seller OAuth for BWA 3D. Opens the authorization page on the HTPC and returns the authorization URL/state. Requires explicit user confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          ...actionConfirm,
          openBrowser: { type: "boolean", default: true }
        },
        additionalProperties: false
      },
      requiredScope: "actions"
    },
    {
      name: "bwa_3d_mercadolibre_api_complete_login",
      description: "Complete Mercado Libre seller OAuth with the authorization code or final redirect URL. Validates OAuth state and stores the rotating token encrypted with Windows DPAPI. Requires explicit user confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          ...actionConfirm,
          code: { type: "string", maxLength: 3000 },
          redirectUrl: { type: "string", maxLength: 8000 },
          state: { type: "string", maxLength: 500 }
        },
        additionalProperties: false
      },
      requiredScope: "actions"
    },
    {
      name: "bwa_3d_mercadolibre_api_refresh",
      description: "Force a Mercado Libre seller access-token refresh. The returned rotating refresh token is persisted atomically and encrypted. Requires explicit user confirmation.",
      inputSchema: {
        type: "object",
        properties: { ...actionConfirm },
        additionalProperties: false
      },
      requiredScope: "actions"
    },
    {
      name: "bwa_3d_mercadolibre_api_logout",
      description: "Remove the stored Mercado Libre seller OAuth token for BWA 3D. Requires explicit user confirmation.",
      inputSchema: {
        type: "object",
        properties: { ...actionConfirm },
        additionalProperties: false
      },
      requiredScope: "actions"
    },
    {
      name: "bwa_3d_mercadolibre_seller_profile",
      description: "Read the authenticated Mercado Libre seller profile and seller reputation.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      requiredScope: "read"
    },
    {
      name: "bwa_3d_mercadolibre_items",
      description: "List BWA 3D Mercado Libre publications. Uses the seller items resource and, when details=true, the current /items/bulk endpoint.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", maxLength: 80 },
          searchType: { type: "string", maxLength: 80 },
          sku: { type: "string", maxLength: 200 },
          orders: { type: "string", maxLength: 200 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          offset: { type: "integer", minimum: 0, maximum: 100000, default: 0 },
          details: { type: "boolean", default: false }
        },
        additionalProperties: false
      },
      requiredScope: "read"
    },
    {
      name: "bwa_3d_mercadolibre_item",
      description: "Read one Mercado Libre publication, optionally including /prices and the current marketplace sale price.",
      inputSchema: {
        type: "object",
        properties: {
          itemId: { type: "string", minLength: 3, maxLength: 100 },
          prices: { type: "boolean", default: true },
          salePrice: { type: "boolean", default: true }
        },
        required: ["itemId"],
        additionalProperties: false
      },
      requiredScope: "read"
    },
    {
      name: "bwa_3d_mercadolibre_item_update",
      description: "Update a Mercado Libre publication with PUT /items/{id}. Supports stock, status, title, attributes, price and other API-supported fields. Price-only updates can be rejected when automated pricing is active. Requires explicit user confirmation and write mode.",
      inputSchema: {
        type: "object",
        properties: {
          ...actionConfirm,
          itemId: { type: "string", minLength: 3, maxLength: 100 },
          patch: { type: "object", additionalProperties: true }
        },
        required: ["itemId", "patch"],
        additionalProperties: false
      },
      requiredScope: "actions"
    },
    {
      name: "bwa_3d_mercadolibre_orders",
      description: "List Mercado Libre orders for the authenticated BWA 3D seller, with optional status/date/query filters.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", maxLength: 80 },
          from: { type: "string", maxLength: 80 },
          to: { type: "string", maxLength: 80 },
          q: { type: "string", maxLength: 300 },
          sort: { type: "string", maxLength: 80, default: "date_desc" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          offset: { type: "integer", minimum: 0, maximum: 100000, default: 0 }
        },
        additionalProperties: false
      },
      requiredScope: "read"
    },
    {
      name: "bwa_3d_mercadolibre_order",
      description: "Read one Mercado Libre order by ID.",
      inputSchema: {
        type: "object",
        properties: { orderId: { type: "string", minLength: 1, maxLength: 100 } },
        required: ["orderId"],
        additionalProperties: false
      },
      requiredScope: "read"
    },
    {
      name: "bwa_3d_mercadolibre_shipment",
      description: "Read one Mercado Libre shipment using the current new shipment JSON format.",
      inputSchema: {
        type: "object",
        properties: { shipmentId: { type: "string", minLength: 1, maxLength: 100 } },
        required: ["shipmentId"],
        additionalProperties: false
      },
      requiredScope: "read"
    },
    {
      name: "bwa_3d_mercadolibre_questions",
      description: "List buyer questions received by BWA 3D using questions API v4.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", maxLength: 80 },
          itemId: { type: "string", maxLength: 100 },
          sortFields: { type: "string", maxLength: 200 },
          sortTypes: { type: "string", maxLength: 200 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          offset: { type: "integer", minimum: 0, maximum: 100000, default: 0 }
        },
        additionalProperties: false
      },
      requiredScope: "read"
    },
    {
      name: "bwa_3d_mercadolibre_answer_question",
      description: "Answer a Mercado Libre buyer question. Requires explicit user confirmation and write mode.",
      inputSchema: {
        type: "object",
        properties: {
          ...actionConfirm,
          questionId: { type: ["integer", "string"] },
          text: { type: "string", minLength: 1, maxLength: 2000 }
        },
        required: ["questionId", "text"],
        additionalProperties: false
      },
      requiredScope: "actions"
    },
    {
      name: "bwa_3d_mercadolibre_messages",
      description: "Read Mercado Libre post-sale messages for a pack.",
      inputSchema: {
        type: "object",
        properties: {
          packId: { type: "string", minLength: 1, maxLength: 100 },
          tag: { type: "string", maxLength: 80, default: "post_sale" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          offset: { type: "integer", minimum: 0, maximum: 100000, default: 0 }
        },
        required: ["packId"],
        additionalProperties: false
      },
      requiredScope: "read"
    },
    {
      name: "bwa_3d_mercadolibre_send_message",
      description: "Send a Mercado Libre post-sale message to a buyer in a pack, optionally referencing previously uploaded attachment IDs. Requires explicit user confirmation and write mode.",
      inputSchema: {
        type: "object",
        properties: {
          ...actionConfirm,
          packId: { type: "string", minLength: 1, maxLength: 100 },
          buyerId: { type: ["integer", "string"] },
          text: { type: "string", minLength: 1, maxLength: 5000 },
          attachments: { type: "array", items: { type: "string", maxLength: 500 }, maxItems: 20 }
        },
        required: ["packId", "buyerId", "text"],
        additionalProperties: false
      },
      requiredScope: "actions"
    },
    {
      name: "bwa_3d_mercadolibre_claims",
      description: "List Mercado Libre post-purchase claims, disputes and mediations with optional filters.",
      inputSchema: {
        type: "object",
        properties: {
          stage: { type: "string", maxLength: 80 },
          status: { type: "string", maxLength: 80 },
          resource: { type: "string", maxLength: 80 },
          resourceId: { type: ["integer", "string"] },
          type: { type: "string", maxLength: 80 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
          offset: { type: "integer", minimum: 0, maximum: 100000, default: 0 }
        },
        additionalProperties: false
      },
      requiredScope: "read"
    },
    {
      name: "bwa_3d_mercadolibre_claim",
      description: "Read one Mercado Libre claim and optionally its detail, messages, expected resolutions, evidences and changes.",
      inputSchema: {
        type: "object",
        properties: {
          claimId: { type: "string", minLength: 1, maxLength: 100 },
          detail: { type: "boolean", default: true },
          messages: { type: "boolean", default: false },
          expectedResolutions: { type: "boolean", default: false },
          evidences: { type: "boolean", default: false },
          changes: { type: "boolean", default: false }
        },
        required: ["claimId"],
        additionalProperties: false
      },
      requiredScope: "read"
    },
    {
      name: "bwa_3d_mercadolibre_api_read",
      description: "Advanced read-only GET access to any path under https://api.mercadolibre.com. The host is fixed and OAuth is automatically refreshed. Useful for new Mercado Libre resources not yet represented by a convenience tool.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, maxLength: 1500 },
          query: { type: "object", additionalProperties: true },
          headers: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } }
        },
        required: ["path"],
        additionalProperties: false
      },
      requiredScope: "read"
    },
    {
      name: "bwa_3d_mercadolibre_api_action",
      description: "Advanced POST/PUT/PATCH/DELETE access to any path under https://api.mercadolibre.com. The host is fixed, dangerous auth/host headers are blocked, OAuth auto-refreshes, and explicit user confirmation plus write mode are required.",
      inputSchema: {
        type: "object",
        properties: {
          ...actionConfirm,
          method: { type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"] },
          path: { type: "string", minLength: 1, maxLength: 1500 },
          query: { type: "object", additionalProperties: true },
          body: {},
          headers: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } }
        },
        required: ["method", "path"],
        additionalProperties: false
      },
      requiredScope: "actions"
    }
  ];

  async function dispatch(tool, args = {}) {
    if (tool === "bwa_3d_mercadolibre_api_status") {
      return { ...(await api.oauthStatus()), allowWrite: api.allowWrite };
    }
    if (tool === "bwa_3d_mercadolibre_api_login") {
      return await api.beginLogin({ openBrowser: args.openBrowser === undefined ? true : Boolean(args.openBrowser) });
    }
    if (tool === "bwa_3d_mercadolibre_api_complete_login") {
      return await api.completeLogin({ code: args.code, redirectUrl: args.redirectUrl, state: args.state });
    }
    if (tool === "bwa_3d_mercadolibre_api_refresh") {
      const token = await api.refresh();
      return {
        ok: true,
        authenticated: true,
        userId: token.user_id ?? null,
        expiresAt: token.expires_at,
        refreshTokenPresent: Boolean(token.refresh_token)
      };
    }
    if (tool === "bwa_3d_mercadolibre_api_logout") return await api.logout();
    if (tool === "bwa_3d_mercadolibre_seller_profile") return await api.sellerProfile();
    if (tool === "bwa_3d_mercadolibre_items") return await api.listItems(args);
    if (tool === "bwa_3d_mercadolibre_item") {
      return await api.getItem(args.itemId, {
        prices: args.prices === undefined ? true : Boolean(args.prices),
        salePrice: args.salePrice === undefined ? true : Boolean(args.salePrice)
      });
    }
    if (tool === "bwa_3d_mercadolibre_item_update") return await api.updateItem(args.itemId, args.patch);
    if (tool === "bwa_3d_mercadolibre_orders") return await api.listOrders(args);
    if (tool === "bwa_3d_mercadolibre_order") return await api.getOrder(args.orderId);
    if (tool === "bwa_3d_mercadolibre_shipment") return await api.getShipment(args.shipmentId);
    if (tool === "bwa_3d_mercadolibre_questions") return await api.listQuestions(args);
    if (tool === "bwa_3d_mercadolibre_answer_question") return await api.answerQuestion(args.questionId, args.text);
    if (tool === "bwa_3d_mercadolibre_messages") return await api.getMessages(args.packId, args);
    if (tool === "bwa_3d_mercadolibre_send_message") return await api.sendMessage(args.packId, args.buyerId, args.text, args.attachments || []);
    if (tool === "bwa_3d_mercadolibre_claims") return await api.listClaims(args);
    if (tool === "bwa_3d_mercadolibre_claim") {
      return await api.getClaim(args.claimId, {
        detail: args.detail === undefined ? true : Boolean(args.detail),
        messages: Boolean(args.messages),
        expectedResolutions: Boolean(args.expectedResolutions),
        evidences: Boolean(args.evidences),
        changes: Boolean(args.changes)
      });
    }
    if (tool === "bwa_3d_mercadolibre_api_read") return await api.rawRead(args.path, args.query || {}, args.headers || {});
    if (tool === "bwa_3d_mercadolibre_api_action") return await api.rawAction(args.method, args.path, args.query || {}, args.body, args.headers || {});
    return undefined;
  }

  return { tools, dispatch };
}
