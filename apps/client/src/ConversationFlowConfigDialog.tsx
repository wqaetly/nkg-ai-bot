import { useMemo, useState } from "react";
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
  onSave: (values: ConversationFlowVariables) => Promise<void>;
}) {
  const initial = useMemo(
    () => normalizeConversationFlowVariables(definitions, values),
    [definitions, values],
  );
  const [draft, setDraft] = useState<ConversationFlowVariables>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const overrideCount = Object.keys(draft).length;

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
