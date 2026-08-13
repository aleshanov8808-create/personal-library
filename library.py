import json

FILE_NAME = "books.json"


def load_books():
    try:
        with open(FILE_NAME, "r", encoding="utf-8") as file:
            return json.load(file)

    except FileNotFoundError:
        print("⚠️ Файл books.json не найден. Создаём пустую библиотеку.")
        return []

    except json.JSONDecodeError:
        print("⚠️ Файл books.json повреждён. Используем пустую библиотеку.")
        return []
    
        


def save_books(books):
    with open(FILE_NAME, "w", encoding="utf-8") as file:
        json.dump(books, file, ensure_ascii=False, indent=4)