import React, { useState } from "react";
import { IconButton, CircularProgress } from "@mui/material";
import { motion } from "framer-motion";
import CheckIcon from "@mui/icons-material/Check";
import AddIcon from "@mui/icons-material/Add";
import CancelOutlinedIcon from "@mui/icons-material/CancelOutlined";

type EndAdornmentProps = {
  onClick: () => Promise<boolean>;
};

const EndAdornment: React.FC<EndAdornmentProps> = ({ onClick }) => {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "failure">("idle");

  const handleClick = async () => {
    if (status !== "idle") return; // Prevent repeated clicks while in loading or success/failure state

    setStatus("loading");
    const isSuccess = await onClick();
    setStatus(isSuccess ? "success" : "failure");

    // Revert back to idle after a delay if not loading
    setTimeout(() => setStatus("idle"), 600);
  };

  return (
    <IconButton
      onClick={handleClick}
      edge="end"
      style={{
        transition: "color 0.3s, opacity 0.3s",
        position: "relative",
      }}
    >
      {status === "loading" && (
        <CircularProgress
          size={24}
          sx={{
            color: "primary.main",
            position: "relative",
          }}
        />
      )}
      {status === "success" && (
        <motion.div
          initial={{ scale: 0, rotate: -25 }}
          animate={{ scale: 1.1, rotate: 0 }}
          exit={{ scale: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 15 }}
          style={{
            color: "green",
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <CheckIcon />
        </motion.div>
      )}
      {status === "failure" && (
        <motion.div
          initial={{ scale: 0, rotate: -25 }}
          animate={{ scale: 1.1, rotate: 0 }}
          exit={{ scale: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 15 }}
          style={{
            color: "red",
            position: "relative",
            display: "flex",
          }}
        >
          <CancelOutlinedIcon />
        </motion.div>
      )}
      {status === "idle" && (
        <motion.div
          initial={{ scale: 1 }}
          animate={{ scale: 1 }}
          style={{
            display: "inline-flex", // Keeps the AddIcon centered
          }}
        >
          <AddIcon />
        </motion.div>
      )}
    </IconButton>
  );
};

export default EndAdornment;
