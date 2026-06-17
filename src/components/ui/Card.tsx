import { forwardRef, HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: "card-dark" | "elevated-dark" | "card-light";
  padding?: "none" | "sm" | "md" | "lg" | "xl";
  radius?: "md" | "lg" | "xl";
}

/**
 * 统一卡片组件 (Unified Card Component)
 * 遵循 DESIGN.md 规范中的 Surfaces 与 Elevation
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant = "card-dark", padding = "lg", radius = "xl", ...props }, ref) => {
    
    const variants = {
      // 基础卡片底色 (暗色模式下的主力面)
      "card-dark": "bg-surface-card-dark text-body-dark",
      // 悬浮/深一层底色 (暗色模式下)
      "elevated-dark": "bg-surface-elevated-dark text-body-dark",
      // 亮色模式卡片底色 (如 transactional pages)
      "card-light": "bg-canvas-light text-ink border border-hairline-light",
    };

    const paddings = {
      "none": "p-0",
      "sm": "p-3", // 12px
      "md": "p-4", // 16px
      "lg": "p-6", // 24px
      "xl": "p-8", // 32px
    };

    const radiuses = {
      "md": "rounded-md", // 6px
      "lg": "rounded-lg", // 8px
      "xl": "rounded-xl", // 12px
    };

    return (
      <div
        ref={ref}
        className={cn(variants[variant], paddings[padding], radiuses[radius], className)}
        {...props}
      />
    );
  }
);

Card.displayName = "Card";
