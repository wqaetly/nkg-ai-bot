import { useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { SHOPPING_PLATFORM_VARIABLE } from "@nkg-ai-bot/commerce-flow";
import type {
  FlowConfigurableVariable,
  FlowConfigurableVariableValue,
} from "@ai-native-flow/flow-ir";
import {
  configurableVariableDefaultLabel,
  normalizeConversationFlowVariables,
  type ConversationFlowVariables,
} from "./conversationFlowConfig";

export function ConversationFlowConfigDialog({
  flowName,
  definitions,
  values,
  onCancel,
  onSave,
}: {
  flowName: string;
  definitions: readonly FlowConfigurableVariable[];
  values: ConversationFlowVariables;
  onCancel: () => void;
  onSave: (values: ConversationFlowVariables, close?: boolean) => Promise<void>;
}) {
  const initial = useMemo(
    () => normalizeConversationFlowVariables(definitions, values),
    [definitions, values],
  );
  const [draft, setDraft] = useState<ConversationFlowVariables>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [openingShop, setOpeningShop] = useState(false);
  const [shopNotice, setShopNotice] = useState("");
  const overrideCount = Object.keys(draft).length;
  const shopping = definitions.find((definition) => definition.name === SHOPPING_PLATFORM_VARIABLE);

  async function openShop() {
    setError("");
    setShopNotice("");
    if (!isTauri()) {
      setError("请在桌面客户端中打开商城登录窗口。");
      return;
    }
    setOpeningShop(true);
    try {
      const provider = draft[SHOPPING_PLATFORM_VARIABLE] ?? shopping?.defaultValue ?? "pdd";
      await onSave(normalizeConversationFlowVariables(definitions, {
        ...draft, [SHOPPING_PLATFORM_VARIABLE]: provider,
      }), false);
      await invoke("commerce_browser_login", { provider });
      setShopNotice("所选商城已保存，商城窗口已打开。完成登录后返回对话发送推荐请求。");
    } catch (cause: unknown) {
      setError(`商城窗口打开失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setOpeningShop(false);
    }
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      await onSave(normalizeConversationFlowVariables(definitions, draft));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  }

  return (
    <section
      aria-label="当前对话 Flow 配置"
      aria-modal="true"
      className="settings-dialog conversation-flow-config-dialog"
      role="dialog"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header>
        <div>
          <span>FLOW CONFIG</span>
          <h2>当前对话配置</h2>
          <p>{flowName} 暴露的运行参数，仅作用于当前对话。</p>
        </div>
        {overrideCount ? <strong>{overrideCount} 项自定义</strong> : <strong className="default">使用 Flow 默认值</strong>}
      </header>
      <div className="conversation-flow-config-fields">
        {definitions.map((definition) => (
          <FlowVariableField
            definition={definition}
            key={definition.name}
            overridden={Object.prototype.hasOwnProperty.call(draft, definition.name)}
            value={draft[definition.name] ?? definition.defaultValue}
            onChange={(value) => setDraft((current) => ({ ...current, [definition.name]: value }))}
            onReset={() => setDraft((current) => {
              const next = { ...current };
              delete next[definition.name];
              return next;
            })}
          />
        ))}
      </div>
      {shopping ? <div className="conversation-flow-config-field">
        <p>打开商城时自动保存平台选择。关闭商城窗口会在本机记住登录，临时登录状态最多保留 7 天；商城要求验证或登录失效时需重新登录。</p>
        <button className="ghost-button" disabled={saving || openingShop} type="button" onClick={() => void openShop()}>{openingShop ? "正在打开商城…" : "打开所选商城 / 登录"}</button>
        {shopNotice ? <small role="status">{shopNotice}</small> : null}
      </div> : null}
      {error ? <p className="conversation-flow-config-error">{error}</p> : null}
      <footer>
        <button
          className="ghost-button conversation-flow-reset-all"
          disabled={!overrideCount || saving}
          type="button"
          onClick={() => setDraft({})}
        >全部恢复默认</button>
        <span />
        <button className="ghost-button" disabled={saving} type="button" onClick={onCancel}>取消</button>
        <button className="primary-button" disabled={saving} type="button" onClick={() => void save()}>
          {saving ? "保存中…" : "保存配置"}
        </button>
      </footer>
    </section>
  );
}

function FlowVariableField({
  definition,
  overridden,
  value,
  onChange,
  onReset,
}: {
  definition: FlowConfigurableVariable;
  overridden: boolean;
  value: FlowConfigurableVariableValue | undefined;
  onChange: (value: FlowConfigurableVariableValue) => void;
  onReset: () => void;
}) {
  return (
    <div className={`conversation-flow-config-field ${overridden ? "overridden" : ""}`}>
      <div className="conversation-flow-config-label">
        <label htmlFor={`flow-variable-${definition.name}`}>{definition.label}</label>
        <code>{definition.name}</code>
        {definition.description ? <p>{definition.description}</p> : null}
      </div>
      <div className="conversation-flow-config-control">
        <VariableControl definition={definition} value={value} onChange={onChange} />
        <button disabled={!overridden} type="button" onClick={onReset}>恢复默认</button>
      </div>
      <small>{overridden ? "当前对话已覆盖" : `Flow 默认：${configurableVariableDefaultLabel(definition)}`}</small>
    </div>
  );
}

function VariableControl({
  definition,
  value,
  onChange,
}: {
  definition: FlowConfigurableVariable;
  value: FlowConfigurableVariableValue | undefined;
  onChange: (value: FlowConfigurableVariableValue) => void;
}) {
  const id = `flow-variable-${definition.name}`;
  if (definition.type === "select") {
    return (
      <select
        id={id}
        value={encodeValue(value)}
        onChange={(event) => {
          const selected = definition.options?.find((option) => encodeValue(option.value) === event.currentTarget.value);
          if (selected) onChange(selected.value);
        }}
      >
        {value === undefined ? <option disabled value="">请选择</option> : null}
        {definition.options?.map((option) => (
          <option key={encodeValue(option.value)} value={encodeValue(option.value)}>{option.label}</option>
        ))}
      </select>
    );
  }
  if (definition.type === "boolean") {
    return (
      <select id={id} value={value === true ? "true" : "false"} onChange={(event) => onChange(event.currentTarget.value === "true")}>
        <option value="true">开启</option>
        <option value="false">关闭</option>
      </select>
    );
  }
  return (
    <input
      id={id}
      max={definition.type === "number" ? definition.max : undefined}
      min={definition.type === "number" ? definition.min : undefined}
      placeholder={definition.placeholder}
      step={definition.type === "number" ? definition.step : undefined}
      type={definition.type === "number" ? "number" : "text"}
      value={value === undefined ? "" : String(value)}
      onChange={(event) => {
        if (definition.type === "number") {
          const number = event.currentTarget.valueAsNumber;
          if (Number.isFinite(number)) onChange(number);
          return;
        }
        onChange(event.currentTarget.value);
      }}
    />
  );
}

function encodeValue(value: FlowConfigurableVariableValue | undefined): string {
  return value === undefined ? "" : `${typeof value}:${String(value)}`;
}
