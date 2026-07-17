import { useState } from "react";
import { Button, CircularProgress, ButtonProps } from "@mui/material";
import { motion } from "framer-motion";
import CheckOutlinedIcon from "@mui/icons-material/CheckOutlined";
import CancelOutlinedIcon from "@mui/icons-material/CancelOutlined";
import CalculateOutlinedIcon from "@mui/icons-material/CalculateOutlined";

interface AnimatedButtonProps {
  text: string;
  height?: number;
  width?: number;
  icon?: ButtonProps["startIcon"];
  status?: "idle" | "loading" | "success" | "failure";
  onClick?: () => Promise<boolean>;
}

const AnimatedButton: React.FC<AnimatedButtonProps> = ({ text, height, width, icon, status: externalStatus, onClick }) => {
  const [internalStatus, setInternalStatus] = useState<"idle" | "loading" | "success" | "failure">("idle");
  const status = externalStatus ?? internalStatus;

  const handleClick = async () => {
    if (!onClick || status !== "idle") return;

    setInternalStatus("loading");
    const isSuccess = await onClick();
    setInternalStatus(isSuccess ? "success" : "failure");
  };

  const handleAnimationComplete = () => {
    if (status !== "loading") {
      setTimeout(() => setInternalStatus("idle"), 400);
    }
  };

  return (
    <Button
      variant="outlined"
      color={status === "success" ? "success" : status === "failure" ? "error" : "primary"}
      startIcon={status === "idle" ? icon : null}
      sx={{
        height: height,
        width: width,
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 5,
      }}
      onClick={handleClick}
      disabled={status !== "idle"}
    >
      {status === "loading" && <CircularProgress size={24} sx={{ color: "primary.main", position: "absolute" }} />}
      {status === "success" && (
        <motion.div
          initial={{ scale: 0, rotate: -25 }}
          animate={{ scale: 1.1, rotate: 0 }}
          exit={{ scale: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 15 }}
          onAnimationComplete={handleAnimationComplete}
          style={{
            color: "green",
            position: "absolute",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <CheckOutlinedIcon />
        </motion.div>
      )}
      {status === "failure" && (
        <motion.div
          initial={{ scale: 0, rotate: -25 }}
          animate={{ scale: 1.1, rotate: 0 }}
          exit={{ scale: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 15 }}
          onAnimationComplete={handleAnimationComplete}
          style={{
            color: "red",
            position: "absolute",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <CancelOutlinedIcon />
        </motion.div>
      )}
      {status === "idle" && text}
    </Button>
  );
};

export default AnimatedButton;
