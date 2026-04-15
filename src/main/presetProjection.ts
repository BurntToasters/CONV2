import {
  PRESET_CATEGORY_LABELS,
  PRESET_CATEGORY_ORDER,
  Preset,
  isPresetCategoryAdvanced,
} from './presets';

export interface RendererPresetProjection {
  id: string;
  name: string;
  description: string;
  category: string;
  categoryLabel: string;
  categoryOrder: number;
  isAdvanced: boolean;
  extension: string;
  aviTier: string | null;
}

export const mapPresetForRenderer = (preset: Preset): RendererPresetProjection => {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    category: preset.category,
    categoryLabel: PRESET_CATEGORY_LABELS[preset.category] || preset.category,
    categoryOrder: PRESET_CATEGORY_ORDER.indexOf(preset.category),
    isAdvanced: isPresetCategoryAdvanced(preset.category),
    extension: preset.extension,
    aviTier: preset.aviTier ?? null,
  };
};

export const mapPresetsForRenderer = (items: Preset[]): RendererPresetProjection[] => {
  return items.map((preset) => mapPresetForRenderer(preset));
};
