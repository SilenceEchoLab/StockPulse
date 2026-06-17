import { ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "primary-pill" | "secondary-on-dark" | "secondary-on-light" | "trading-up" | "trading-down" | "subscribe" | "tertiary-text";
}

/**
 * 统一按钮组件 (Unified Button Component)
 * 遵循 DESIGN.md 规范中的组件定义。
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", ...props }, ref) => {
    
    // 基础样式
    const baseStyles = "inline-flex items-center justify-center font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-info focus:ring-offset-2 focus:ring-offset-canvas-dark disabled:opacity-50 disabled:cursor-not-allowed";

    // 根据 variant 配置对应的样式
    const variants = {
      // 核心主按钮: Binance Yellow
      "primary": "bg-primary text-ink rounded-md px-6 py-2 text-[14px] hover:bg-primary-active disabled:bg-primary-disabled disabled:text-muted h-10",
      
      // 圆角主按钮: 适用于大核心动作 (如 Sign Up)
      "primary-pill": "bg-primary text-ink rounded-pill px-8 py-3.5 text-[14px] hover:bg-primary-active",
      
      // 次要按钮 (深色背景上)
      "secondary-on-dark": "bg-surface-card-dark text-white rounded-md px-4 py-2 text-[14px] hover:bg-surface-elevated-dark",
      
      // 次要按钮 (浅色背景上)
      "secondary-on-light": "bg-canvas-light text-ink border border-hairline-light rounded-md px-4 py-2 text-[14px] hover:bg-surface-strong-light",
      
      // 交易看多按钮 (绿色)
      "trading-up": "bg-trading-up text-white rounded-sm px-5 py-2 text-[14px] hover:opacity-90 h-8",
      
      // 交易看空按钮 (红色)
      "trading-down": "bg-trading-down text-white rounded-sm px-5 py-2 text-[14px] hover:opacity-90 h-8",
      
      // 关注/订阅按钮 (黄色, 紧凑)
      "subscribe": "bg-primary text-ink rounded-md px-4 py-1.5 text-[13px] hover:bg-primary-active h-7",
      
      // 文本按钮 (如登录链接)
      "tertiary-text": "bg-transparent text-primary hover:text-primary-active px-2 py-1 text-[14px]",
    };

    return (
      <button
        ref={ref}
        className={cn(baseStyles, variants[variant], className)}
        {...props}
      />
    );
  }
);

Button.displayName = "Button";
