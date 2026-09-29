.PHONY: docker-install docker-install-apt docker-install-dnf \
        docker-uninstall docker-uninstall-apt docker-uninstall-dnf \
        up build start down nuke

# --- Docker installation -----------------------------------------------------

docker-install:
	@if command -v apt-get >/dev/null 2>&1; then \
		$(MAKE) docker-install-apt; \
	elif command -v dnf >/dev/null 2>&1; then \
		$(MAKE) docker-install-dnf; \
	else \
		echo "Unsupported distro: expected apt-get (Debian/Ubuntu) or dnf (Fedora)."; \
		exit 1; \
	fi

docker-install-apt:
	@echo "Installing Docker (apt)..."
	@sudo apt-get update
	@sudo apt-get install -y apt-transport-https ca-certificates curl gnupg lsb-release software-properties-common
	@curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --yes --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
	@echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $$(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
	@sudo apt-get update
	@sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
	@sudo systemctl enable --now docker
	@echo "Docker installation completed."

docker-install-dnf:
	@echo "Installing Docker (dnf)..."
	@sudo curl -fsSL https://download.docker.com/linux/fedora/docker-ce.repo -o /etc/yum.repos.d/docker-ce.repo
	@sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
	@sudo systemctl enable --now docker
	@echo "Docker installation completed."

docker-uninstall:
	@if command -v apt-get >/dev/null 2>&1; then \
		$(MAKE) docker-uninstall-apt; \
	elif command -v dnf >/dev/null 2>&1; then \
		$(MAKE) docker-uninstall-dnf; \
	else \
		echo "Unsupported distro: expected apt-get (Debian/Ubuntu) or dnf (Fedora)."; \
		exit 1; \
	fi

docker-uninstall-apt:
	@echo "Uninstalling Docker (apt)..."
	@sudo apt-get purge -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
	@sudo rm -rf /var/lib/docker /var/lib/containerd
	@sudo rm -f /etc/apt/sources.list.d/docker.list /usr/share/keyrings/docker-archive-keyring.gpg
	@echo "Docker uninstallation completed."

docker-uninstall-dnf:
	@echo "Uninstalling Docker (dnf)..."
	@sudo dnf remove -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
	@sudo rm -rf /var/lib/docker /var/lib/containerd
	@sudo rm -f /etc/yum.repos.d/docker-ce.repo
	@echo "Docker uninstallation completed."


up:
	docker compose up --build -d

start:
	docker compose start	

down:
	docker compose down -v

nuke:
	docker compose down -v --rmi all --remove-orphans
