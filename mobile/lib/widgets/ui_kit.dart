/// Reusable mobile UI primitives: surface cards, status badges, error
/// banners, empty states, and animated running indicators.
library;

import 'package:flutter/material.dart';

import '../core/app_theme.dart';

/// Rounded white card with subtle hairline border used across Home / Settings / Connect.
class SurfaceCard extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  final EdgeInsetsGeometry? margin;
  final double radius;
  final Color color;
  final Color borderColor;

  const SurfaceCard({
    required this.child,
    this.padding = const EdgeInsets.all(14),
    this.margin,
    this.radius = 14,
    this.color = AppColors.surface,
    this.borderColor = AppColors.border,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    final card = Material(
      color: color,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(radius),
        side: BorderSide(color: borderColor),
      ),
      child: Padding(padding: padding, child: child),
    );
    if (margin == null) return card;
    return Padding(padding: margin!, child: card);
  }
}

/// Compact rounded pill badge for host/model/turn status.
class StatusBadge extends StatelessWidget {
  final String label;
  final Color foreground;
  final Color background;
  final Color? borderColor;
  final Widget? leading;

  const StatusBadge({
    required this.label,
    required this.foreground,
    required this.background,
    this.borderColor,
    this.leading,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(10),
        border: borderColor == null ? null : Border.all(color: borderColor!),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (leading != null) ...[
            leading!,
            const SizedBox(width: 4),
          ],
          Text(
            label,
            style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: foreground),
          ),
        ],
      ),
    );
  }
}

/// Soft error notice card with optional recovery actions.
class ErrorBanner extends StatelessWidget {
  final String message;
  final Widget? action;
  final EdgeInsetsGeometry margin;

  const ErrorBanner({
    required this.message,
    this.action,
    this.margin = EdgeInsets.zero,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: margin,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.dangerBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.dangerBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Padding(
                padding: EdgeInsets.only(top: 1),
                child: Icon(Icons.error_outline, size: 16, color: AppColors.danger),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  message,
                  style: const TextStyle(color: AppColors.danger, fontSize: 12.5, height: 1.4),
                ),
              ),
            ],
          ),
          if (action != null) ...[
            const SizedBox(height: 6),
            action!,
          ],
        ],
      ),
    );
  }
}

/// Centered empty / offline / error state with soft icon circle and CTAs.
class EmptyStateView extends StatelessWidget {
  final IconData icon;
  final Color iconColor;
  final Color iconBg;
  final String title;
  final String? subtitle;
  final List<Widget> actions;

  const EmptyStateView({
    required this.icon,
    required this.title,
    this.subtitle,
    this.iconColor = AppColors.brand,
    this.iconBg = AppColors.brandSoft,
    this.actions = const [],
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(color: iconBg, shape: BoxShape.circle),
              child: Icon(icon, size: 28, color: iconColor),
            ),
            const SizedBox(height: 14),
            Text(
              title,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w600,
                color: AppColors.textPrimary,
                height: 1.45,
              ),
            ),
            if (subtitle != null && subtitle!.trim().isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                subtitle!,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 13, color: AppColors.textMuted, height: 1.5),
              ),
            ],
            if (actions.isNotEmpty) ...[
              const SizedBox(height: 16),
              Wrap(
                spacing: 10,
                runSpacing: 8,
                alignment: WrapAlignment.center,
                children: actions,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Crisp status dot with an optional soft halo ring when active (never uses an
/// unbounded ticker so widget tests using `pumpAndSettle` stay reliable).
class StatusDot extends StatelessWidget {
  final Color color;
  final double size;
  final bool active;

  const StatusDot({
    this.color = AppColors.brand,
    this.size = 8,
    this.active = false,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    final dot = Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
    if (!active) return dot;
    return Container(
      width: size + 6,
      height: size + 6,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.18),
        shape: BoxShape.circle,
      ),
      child: dot,
    );
  }
}
