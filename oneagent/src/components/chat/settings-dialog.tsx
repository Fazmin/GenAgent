"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PROVIDERS, type Settings } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Check, Eye, EyeOff, Save, Loader2 } from "lucide-react";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [settings, setSettings] = useState<Partial<Settings>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  useEffect(() => {
    if (open) {
      loadSettings();
    }
  }, [open]);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
      }
    } catch (error) {
      console.error("Failed to load settings:", error);
    } finally {
      setLoading(false);
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (error) {
      console.error("Failed to save settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const selectedProvider =
    PROVIDERS.find((p) => p.value === settings.provider) || PROVIDERS[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure your AI provider, model, and API key.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-6 py-2">
            {/* Provider Selection */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Provider</label>
              <div className="grid grid-cols-2 gap-2">
                {PROVIDERS.map((provider) => (
                  <Button
                    key={provider.value}
                    variant="outline"
                    className={cn(
                      "justify-start gap-2 h-10",
                      settings.provider === provider.value &&
                        "border-primary bg-primary/5 ring-1 ring-primary"
                    )}
                    onClick={() =>
                      setSettings((prev) => ({
                        ...prev,
                        provider: provider.value,
                        model: provider.models[0],
                      }))
                    }
                  >
                    {settings.provider === provider.value && (
                      <Check className="h-3.5 w-3.5 text-primary" />
                    )}
                    <span className="text-sm">{provider.label}</span>
                  </Button>
                ))}
              </div>
            </div>

            {/* Model Selection */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Model</label>
              <div className="flex flex-wrap gap-1.5">
                {selectedProvider.models.map((model) => (
                  <Badge
                    key={model}
                    variant={
                      settings.model === model ? "default" : "secondary"
                    }
                    className={cn(
                      "cursor-pointer text-xs px-2.5 py-1 transition-colors",
                      settings.model === model
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-accent"
                    )}
                    onClick={() =>
                      setSettings((prev) => ({ ...prev, model }))
                    }
                  >
                    {model}
                  </Badge>
                ))}
              </div>
              <Input
                value={settings.model || ""}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, model: e.target.value }))
                }
                placeholder="Or enter a custom model ID"
                className="text-sm h-9"
              />
            </div>

            {/* API Key */}
            <div className="space-y-2">
              <label className="text-sm font-medium">API Key</label>
              <div className="relative">
                <Input
                  type={showApiKey ? "text" : "password"}
                  value={settings.apiKey || ""}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, apiKey: e.target.value }))
                  }
                  placeholder={`Enter your ${selectedProvider.label} API key`}
                  className="text-sm h-9 pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-9 w-9"
                  onClick={() => setShowApiKey(!showApiKey)}
                >
                  {showApiKey ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                The API key is stored locally in the SQLite database. You can
                also set it via environment variables (e.g. ANTHROPIC_API_KEY).
              </p>
            </div>

            {/* Advanced Settings */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Max Turns</label>
              <Input
                type="number"
                value={settings.maxTurns || "20"}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    maxTurns: e.target.value,
                  }))
                }
                placeholder="20"
                className="text-sm h-9 w-24"
                min={1}
                max={100}
              />
              <p className="text-xs text-muted-foreground">
                Maximum number of loop turns per request.
              </p>
            </div>

            {/* Save Button */}
            <Button
              onClick={saveSettings}
              className="w-full gap-2"
              disabled={saving}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : saved ? (
                <Check className="h-4 w-4" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {saving ? "Saving..." : saved ? "Saved!" : "Save Settings"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
